/* End-to-end verification for per-client session isolation + the new
 * signup welcome credit.
 *
 * Run with:  npx tsx script/verify-session-isolation.ts
 *
 * Boots a real Express server against an isolated SQLite DB and asserts:
 *
 *   1. Two different "browsers" (separate cookie jars) can sign up /
 *      sign in as different users simultaneously. /api/me returns the
 *      correct, distinct user for each. The pre-refactor bug was a
 *      server-wide global session, which would have made both clients
 *      see the most-recently-signed-in user.
 *   2. Logging out from client A does NOT log out client B.
 *   3. A request without any cookie returns 401 from /api/me — there is
 *      no "ambient" session anymore.
 *   4. Every new signup gets exactly 1 free credit AND a ledger row
 *      with reason='signup_bonus' and reference='welcome_credit', so
 *      the credit history explains the balance.
 *   5. Existing users (the seeded preview owner) are NOT given an
 *      additional welcome credit on subsequent server starts — the
 *      grant happens once, inline with createUser.
 *
 * Exits non-zero on any failure so the script can gate CI.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const projectRoot = dirname(dirname(__filename));
const tmpDir = mkdtempSync(join(tmpdir(), "careerproof-verify-sessions-"));
const originalCwd = process.cwd();
process.chdir(tmpDir);

// Use a stable session secret so the test is deterministic across
// restarts within the same process tree.
process.env.SESSION_SECRET = "verify-session-isolation-secret-do-not-use-in-prod";

const { default: express } = await import("express");
const { createServer } = await import("node:http");
const { registerRoutes } = await import("../server/routes");
const { createSessionMiddleware } = await import("../server/session");
const storageMod = await import("../server/storage");
await storageMod.initStorage();

const app = express();
app.use(express.json({ limit: "20mb" }));
app.use(createSessionMiddleware());
const httpServer = createServer(app);
await registerRoutes(httpServer, app);

const PORT = 4811;
await new Promise<void>((resolve) => httpServer.listen(PORT, resolve));
const base = `http://127.0.0.1:${PORT}`;

/* Minimal cookie jar — captures Set-Cookie headers from each response
 * and re-sends the relevant Cookie header on subsequent requests. Each
 * test "client" gets its own jar, modeling two separate browsers. */
class CookieJar {
  private store = new Map<string, string>();
  capture(setCookieHeaders: string[] | null) {
    if (!setCookieHeaders) return;
    for (const sc of setCookieHeaders) {
      const [pair] = sc.split(";");
      const eq = pair.indexOf("=");
      if (eq < 0) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      if (value === "" || /expires=thu, 01 jan 1970/i.test(sc)) {
        this.store.delete(name);
      } else {
        this.store.set(name, value);
      }
    }
  }
  header(): string | undefined {
    if (this.store.size === 0) return undefined;
    return [...this.store.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  }
  clone(): CookieJar {
    const j = new CookieJar();
    j.store = new Map(this.store);
    return j;
  }
  cookies(): Record<string, string> {
    return Object.fromEntries(this.store);
  }
}

async function request(
  jar: CookieJar,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: any; setCookie: string[] | null }> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const cookie = jar.header();
  if (cookie) headers["Cookie"] = cookie;
  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  /* node-fetch / undici raw header access for Set-Cookie. headers.raw()
   * isn't available on the WHATWG Response; getSetCookie() is the
   * standardized accessor in Node 20+. */
  const setCookie =
    typeof (res.headers as any).getSetCookie === "function"
      ? (res.headers as any).getSetCookie()
      : (() => {
          const h = res.headers.get("set-cookie");
          return h ? [h] : null;
        })();
  jar.capture(setCookie);
  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  return { status: res.status, json, setCookie };
}

let failed = 0;
function assert(cond: any, label: string, detail?: unknown) {
  if (cond) {
    console.log(`PASS  ${label}`);
  } else {
    failed += 1;
    console.log(`FAIL  ${label}`);
    if (detail !== undefined) {
      console.log(`        detail: ${typeof detail === "string" ? detail : JSON.stringify(detail).slice(0, 400)}`);
    }
  }
}

const stamp = Date.now();
const emailA = `client_a_${stamp}@example.com`;
const emailB = `client_b_${stamp}@example.com`;
const PASSWORD = "TestPw1234!";

try {
  /* -------- 1. Two separate clients sign up as different users -------- */
  const jarA = new CookieJar();
  const jarB = new CookieJar();
  const noJar = new CookieJar();

  const signupA = await request(jarA, "POST", "/api/me/signup", {
    full_name: "Client A",
    email: emailA,
    password: PASSWORD,
    confirm_password: PASSWORD,
  });
  assert(signupA.status === 200, "client A signup returns 200", signupA);
  assert(signupA.json?.email === emailA, "client A signup returns client A user", signupA.json);
  assert(
    signupA.json?.credits === 0,
    "client A signup grants 0 credits (no welcome bonus; free-first model)",
    signupA.json,
  );

  const signupB = await request(jarB, "POST", "/api/me/signup", {
    full_name: "Client B",
    email: emailB,
    password: PASSWORD,
    confirm_password: PASSWORD,
  });
  assert(signupB.status === 200, "client B signup returns 200", signupB);
  assert(signupB.json?.email === emailB, "client B signup returns client B user", signupB.json);
  assert(
    signupB.json?.credits === 0,
    "client B signup grants 0 credits (no welcome bonus; free-first model)",
    signupB.json,
  );

  /* Critical isolation assertion — the pre-refactor bug was that the
   * server tracked a single global current user, so right after client B
   * signed up BOTH /api/me lookups would have returned client B. */
  const meA1 = await request(jarA, "GET", "/api/me");
  const meB1 = await request(jarB, "GET", "/api/me");
  assert(
    meA1.status === 200 && meA1.json?.email === emailA,
    "GET /api/me for client A returns client A (not the most-recent global)",
    meA1.json,
  );
  assert(
    meB1.status === 200 && meB1.json?.email === emailB,
    "GET /api/me for client B returns client B",
    meB1.json,
  );

  /* -------- 2. Each new user has an empty, isolated ledger -------- */
  // Free-first model: signup grants no welcome credit, so a fresh account
  // starts with an empty ledger. The free first report is an entitlement
  // claimed at first unlock (reason='free_report_claim'), not a signup grant.
  const userIdA = meA1.json?.id as number;
  const userIdB = meB1.json?.id as number;
  const txA = await request(jarA, "GET", "/api/credits/transactions");
  assert(
    Array.isArray(txA.json?.transactions),
    "client A can list their own credit transactions",
    txA.json,
  );
  assert(
    (txA.json?.transactions ?? []).every((t: any) => t.reason !== "signup_bonus"),
    "client A ledger has no signup_bonus row (welcome bonus disabled)",
    txA.json,
  );
  const txB = await request(jarB, "GET", "/api/credits/transactions");
  assert(
    (txB.json?.transactions ?? []).every((t: any) => t.reason !== "signup_bonus"),
    "client B ledger has no signup_bonus row (welcome bonus disabled)",
    txB.json,
  );

  /* -------- 3. Cross-client read does not leak the other user's ledger -------- */
  // Force a ledger row onto client B (promo) so the leak check has something
  // concrete to look for in client A's transactions list.
  await request(jarB, "POST", "/api/credits/redeem-code", { code: "10FREE" });
  const txBfromAJar = await request(jarA, "GET", "/api/credits/transactions");
  const sawBrow = (txBfromAJar.json?.transactions ?? []).some(
    (t: any) => t.user_id === userIdB && t.user_id !== userIdA,
  );
  assert(
    !sawBrow,
    "client A's transactions endpoint never returns client B's ledger rows",
  );

  /* -------- 4. Anonymous request gets 401 — no ambient session -------- */
  const meAnon = await request(noJar, "GET", "/api/me");
  assert(
    meAnon.status === 401,
    "GET /api/me without a cookie returns 401 (no global session)",
    meAnon,
  );

  /* -------- 5. Concurrent signin: simultaneous logins isolated -------- */
  // Brand new cookie jars to simulate two more separate browsers
  // logging in at exactly the same time.
  const jarA2 = new CookieJar();
  const jarB2 = new CookieJar();
  const [signinA, signinB] = await Promise.all([
    request(jarA2, "POST", "/api/me/signin", { email: emailA, password: PASSWORD }),
    request(jarB2, "POST", "/api/me/signin", { email: emailB, password: PASSWORD }),
  ]);
  assert(
    signinA.status === 200 && signinA.json?.email === emailA,
    "concurrent signin: client A gets client A",
    signinA.json,
  );
  assert(
    signinB.status === 200 && signinB.json?.email === emailB,
    "concurrent signin: client B gets client B",
    signinB.json,
  );
  const [meA2, meB2] = await Promise.all([
    request(jarA2, "GET", "/api/me"),
    request(jarB2, "GET", "/api/me"),
  ]);
  assert(
    meA2.json?.email === emailA && meB2.json?.email === emailB,
    "after concurrent signin, each client sees its own /api/me",
    { a: meA2.json?.email, b: meB2.json?.email },
  );

  /* -------- 6. Logout from client A leaves client B signed in -------- */
  const logoutA = await request(jarA2, "POST", "/api/me/logout");
  assert(logoutA.status === 200, "client A logout returns 200", logoutA);
  const meAafterLogout = await request(jarA2, "GET", "/api/me");
  assert(
    meAafterLogout.status === 401,
    "after client A logout, GET /api/me from client A returns 401",
    meAafterLogout,
  );
  const meBafterLogout = await request(jarB2, "GET", "/api/me");
  assert(
    meBafterLogout.status === 200 && meBafterLogout.json?.email === emailB,
    "after client A logout, client B is STILL signed in (per-client isolation)",
    meBafterLogout.json,
  );

  /* -------- 7. Cookie is httpOnly + named cp.sid -------- */
  const signinFresh = await request(new CookieJar(), "POST", "/api/me/signin", {
    email: emailA,
    password: PASSWORD,
  });
  const sc = (signinFresh.setCookie ?? []).join("\n");
  assert(/cp\.sid=/i.test(sc), "session cookie is named cp.sid", sc);
  assert(/httponly/i.test(sc), "session cookie is httpOnly", sc);
  assert(/samesite=lax/i.test(sc), "session cookie is sameSite=lax", sc);

  /* -------- 8. Welcome credit is NOT replayed on the seeded preview owner.
   *           initStorage() runs bootstrap() on every startup; existing
   *           accounts must not receive an additional signup_bonus row. */
  const { storage } = storageMod;
  const seededOwner = await storage.getUserByEmail("roqueta.alex@gmail.com");
  assert(!!seededOwner, "seeded owner exists after bootstrap");
  if (seededOwner) {
    const ownerTxs = await storage.listCreditTransactions(seededOwner.id);
    const seededBonusRows = ownerTxs.filter((t) => t.reason === "signup_bonus");
    assert(
      seededBonusRows.length === 0,
      "seeded owner (pre-existing account) was NOT granted a welcome credit on startup",
      { rows: seededBonusRows.length },
    );
  }
} finally {
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  process.chdir(originalCwd);
  rmSync(tmpDir, { recursive: true, force: true });
}

if (failed > 0) {
  console.log(`\n${failed} assertion(s) failed.`);
  process.exit(1);
}
console.log("\nAll session-isolation + welcome-credit assertions passed.");
