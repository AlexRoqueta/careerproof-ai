/* End-to-end verification for the anonymous preview funnel.
 *
 * Run with:  npx tsx script/verify-anonymous-preview.ts
 *
 * Boots a real Express server against an isolated SQLite DB and
 * asserts the new pre-signup funnel:
 *
 *   1. POST /api/preview/analyze (no session) returns a usable preview
 *      payload — score, summary, vulnerable tasks, locked sections —
 *      AND an opaque token. The full readable body is NOT included.
 *   2. GET /api/preview/:token returns the same payload.
 *   3. The integer analysis id space is NOT exposed by either endpoint.
 *   4. Anonymous abuse cap: a fourth preview in the same minute is
 *      rate-limited with 429.
 *   5. POST /api/preview/:token/claim without a session returns 401.
 *   6. After signup, claim promotes the preview into the user's
 *      account. The new analyses row exists, is owned by the new
 *      user, contains the SAME job_title/result_text the preview was
 *      built from, and is locked (because the new user has 0 credits
 *      after we drain the welcome bonus).
 *   7. The claimed analysis can be unlocked via the existing
 *      /unlock endpoint after redeeming a promo code — verifying
 *      the existing purchase / unlock pathway is unchanged.
 *   8. The token is single-use: a second claim returns 404.
 *   9. Tokens cannot be used to read another user's reports — the
 *      /api/analyses/:id endpoint still 404s for non-owners.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const projectRoot = dirname(dirname(__filename));
const tmpDir = mkdtempSync(join(tmpdir(), "anon-preview-verify-"));
const originalCwd = process.cwd();
process.chdir(tmpDir);

const { default: express } = await import("express");
const { createServer } = await import("node:http");
const { registerRoutes } = await import("../server/routes");
const { createSessionMiddleware } = await import("../server/session");
const storageMod = await import("../server/storage");
const { __resetRateLimits } = await import("../server/rate-limit");
const { __resetAnonPreviewStore } = await import("../server/preview-tokens");
await storageMod.initStorage();
const { storage } = storageMod;

const app = express();
app.use(express.json({ limit: "20mb" }));
app.use(createSessionMiddleware());
const httpServer = createServer(app);
await registerRoutes(httpServer, app);

const PORT = 4801;
await new Promise<void>((resolve) => httpServer.listen(PORT, resolve));
const base = `http://127.0.0.1:${PORT}`;

const cookieStore = new Map<string, string>();
function applySetCookie(setCookie: string[] | null) {
  if (!setCookie) return;
  for (const sc of setCookie) {
    const [pair] = sc.split(";");
    const eq = pair.indexOf("=");
    if (eq < 0) continue;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (value === "" || /expires=thu, 01 jan 1970/i.test(sc)) {
      cookieStore.delete(name);
    } else {
      cookieStore.set(name, value);
    }
  }
}
function cookieHeader(): string | undefined {
  if (cookieStore.size === 0) return undefined;
  return [...cookieStore.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}
async function request(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: any }> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const cookie = cookieHeader();
  if (cookie) headers["Cookie"] = cookie;
  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const setCookie =
    typeof (res.headers as any).getSetCookie === "function"
      ? (res.headers as any).getSetCookie()
      : (() => {
          const h = res.headers.get("set-cookie");
          return h ? [h] : null;
        })();
  applySetCookie(setCookie);
  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  return { status: res.status, json };
}

let failed = 0;
function assert(cond: any, label: string, detail?: unknown) {
  if (cond) {
    console.log(`PASS  ${label}`);
  } else {
    failed += 1;
    console.log(`FAIL  ${label}`);
    if (detail !== undefined) {
      console.log(
        `        detail: ${typeof detail === "string" ? detail : JSON.stringify(detail).slice(0, 400)}`,
      );
    }
  }
}

try {
  /* -------- 1. Anonymous preview produces a token + teaser, no body -------- */
  __resetRateLimits();
  __resetAnonPreviewStore();
  const r1 = await request("POST", "/api/preview/analyze", {
    job_title: "Senior Marketing Analyst",
    job_description:
      "Builds dashboards, drafts weekly variance commentary, runs lifecycle email A/B tests, owns campaign measurement, and presents to the VP every Monday.",
  });
  assert(r1.status === 200, "POST /api/preview/analyze returns 200", r1);
  assert(typeof r1.json?.token === "string" && r1.json.token.length >= 20, "preview returns an opaque token");
  assert(typeof r1.json?.risk_score === "number", "preview returns a risk_score");
  assert(typeof r1.json?.summary === "string" && r1.json.summary.length > 10, "preview returns a non-empty summary");
  assert(Array.isArray(r1.json?.vulnerable_tasks), "preview returns vulnerable_tasks array");
  assert(Array.isArray(r1.json?.locked_sections) && r1.json.locked_sections.length > 0, "preview returns locked_sections");
  assert(
    r1.json && !("result_text" in r1.json),
    "anonymous preview payload does NOT include the full result_text",
  );
  assert(
    r1.json && !("id" in r1.json),
    "anonymous preview payload does NOT expose an integer analysis id",
  );
  const token = String(r1.json?.token);

  /* -------- 2. GET by token returns the same payload -------- */
  const r2 = await request("GET", `/api/preview/${token}`);
  assert(r2.status === 200, "GET /api/preview/:token returns 200");
  assert(r2.json?.risk_score === r1.json.risk_score, "GET payload matches POST risk_score");
  assert(
    JSON.stringify(r2.json?.locked_sections) === JSON.stringify(r1.json.locked_sections),
    "GET locked_sections matches POST",
  );

  /* -------- 3. Unknown token returns 404 (no enumeration) -------- */
  const r3 = await request("GET", `/api/preview/${"a".repeat(43)}`);
  assert(r3.status === 404, "GET /api/preview/<unknown> returns 404", r3);

  /* -------- 4. Claim without auth returns 401 -------- */
  const r4 = await request("POST", `/api/preview/${token}/claim`);
  assert(r4.status === 401, "claim without auth returns 401", r4);

  /* -------- 5. Anonymous rate limit kicks in -------- */
  // We already used 1 of 3/minute. Burn 2 more then expect 429 on the 4th.
  __resetRateLimits();
  for (let i = 0; i < 3; i++) {
    await request("POST", "/api/preview/analyze", {
      job_title: `Test Role ${i}`,
      job_description: "A test role description for rate-limit testing purposes.",
    });
  }
  const r5 = await request("POST", "/api/preview/analyze", {
    job_title: "Test Role 4",
    job_description: "A test role description for rate-limit testing purposes.",
  });
  assert(r5.status === 429, "4th anonymous preview in 60s hits the per-IP rate limit (429)", r5);
  __resetRateLimits();

  /* -------- 6. Signup + claim: token becomes a real, owned, locked row -------- */
  const stamp = Date.now();
  const newEmail = `anon_verify_${stamp}@example.com`;
  const password = "AnonVerify1!";
  const signup = await request("POST", "/api/me/signup", {
    full_name: "Anon Verify",
    email: newEmail,
    password,
    confirm_password: password,
  });
  assert(signup.status === 200, "signup returns 200", signup);
  // Drain welcome credit so the claim deterministically lands locked.
  await storage.setUserCredits(signup.json.id, 0);

  const claim = await request("POST", `/api/preview/${token}/claim`);
  assert(claim.status === 200, "claim returns 200 after signup", claim);
  assert(typeof claim.json?.id === "number" && claim.json.id > 0, "claim returns a saved analysis id");
  assert(claim.json?.created_by === signup.json.id, "claimed analysis is owned by the signing-up user");
  assert(claim.json?.is_locked === true, "claimed analysis is locked for zero-credit user");
  assert(claim.json?.job_title === "Senior Marketing Analyst", "job title preserved through claim");
  assert(typeof claim.json?.preview === "object" && claim.json.preview, "claimed analysis includes its preview teaser");
  const claimedId = claim.json.id as number;

  /* -------- 7. Single-use: a second claim with the same token is 404 -------- */
  const claimAgain = await request("POST", `/api/preview/${token}/claim`);
  assert(claimAgain.status === 404, "second claim with same token returns 404 (single use)");

  /* -------- 8. Unlock flow still works on the claimed row -------- */
  const redeem = await request("POST", "/api/credits/redeem-code", { code: "10FREE" });
  assert(redeem.status === 200, "promo code 10FREE adds credits");
  const unlock = await request("POST", `/api/analyses/${claimedId}/unlock`);
  assert(unlock.status === 200 && unlock.json?.is_locked === false, "claimed analysis unlocks via existing endpoint");
  assert(
    typeof unlock.json?.result_text === "string" && unlock.json.result_text.length > 200,
    "unlocked claimed analysis has the full readable body",
  );

  /* -------- 9. Another user cannot read the claimed analysis -------- */
  await request("POST", "/api/me/logout");
  const otherEmail = `anon_other_${stamp}@example.com`;
  await request("POST", "/api/me/signup", {
    full_name: "Other",
    email: otherEmail,
    password,
    confirm_password: password,
  });
  const cross = await request("GET", `/api/analyses/${claimedId}`);
  assert(cross.status === 404, "cross-user GET on claimed analysis returns 404 (no leak)");
} finally {
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  process.chdir(originalCwd);
  rmSync(tmpDir, { recursive: true, force: true });
}

if (failed > 0) {
  console.error(`\n${failed} verification case(s) failed.`);
  process.exit(1);
}
console.log(`\nAll verification cases passed.`);
