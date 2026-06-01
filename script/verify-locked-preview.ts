/* End-to-end verification for the zero-credit locked preview flow.
 *
 * Run with:  npx tsx script/verify-locked-preview.ts
 *
 * Boots a real Express server against an isolated SQLite DB and asserts:
 *
 *   1. A freshly created account starts with zero credits (no implicit
 *      free quota).
 *   2. A zero-credit, non-unlimited user can still POST /api/analyses,
 *      but the returned record has is_locked=true and the result_text
 *      contains no readable body content — only headings + redaction
 *      markers.
 *   3. GET /api/analyses and GET /api/analyses/:id also return the
 *      redacted body for that user (defense-in-depth — devtools-readable
 *      payloads must not leak the analysis).
 *   4. The unlimited entitlement (roqueta.alex@gmail.com) still receives
 *      a fully unlocked analysis with the readable body intact.
 *   5. POST /api/credits/redeem-code "10FREE" grants credits, after which
 *      POST /api/analyses/:id/unlock returns the full readable body and
 *      decrements credits by exactly one.
 *
 * Exits non-zero on any failure so the script can gate CI.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

// Point storage at an isolated DB before importing it. The storage module
// opens "data.db" relative to process.cwd(), so we chdir into a tmp dir.
const __filename = fileURLToPath(import.meta.url);
const projectRoot = dirname(dirname(__filename));
const tmpDir = mkdtempSync(join(tmpdir(), "ousted-verify-"));
const originalCwd = process.cwd();
process.chdir(tmpDir);

// Dynamic import so the chdir takes effect before SQLite opens the file.
const { default: express } = await import("express");
const { createServer } = await import("node:http");
const { registerRoutes } = await import("../server/routes");
const { createSessionMiddleware } = await import("../server/session");
const storageMod = await import("../server/storage");
await storageMod.initStorage();
const { storage } = storageMod;

const app = express();
app.use(express.json({ limit: "20mb" }));
app.use(createSessionMiddleware());
const httpServer = createServer(app);
await registerRoutes(httpServer, app);

const PORT = 4799;
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
      console.log(`        detail: ${typeof detail === "string" ? detail : JSON.stringify(detail).slice(0, 400)}`);
    }
  }
}

function bodyLooksReadable(md: string): boolean {
  // Look for sentence-like content outside of headings — punctuation,
  // spaces, and at least a few alphabetic words. The redacted form is
  // only block characters plus markdown scaffolding.
  const lines = md.split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (/^#{1,3}\s/.test(line)) continue; // heading
    if (/^---+$/.test(line)) continue; // hr
    // Count alphabetic word-like tokens (3+ letters in a row).
    const words = line.match(/[A-Za-z]{3,}/g) ?? [];
    if (words.length >= 3) return true;
  }
  return false;
}

// Note: the storage bootstrap may have pre-seeded users. Use unique emails
// so reruns and existing DB state do not collide.
const stamp = Date.now();
const newEmail = `verify_new_${stamp}@example.com`;
const unlimitedEmail = "roqueta.alex@gmail.com";
// Preview-only password used to seed the unlimited account in the
// isolated test DB. Matches server/storage.ts SEEDED_OWNER_TEMP_PASSWORD
// when the bootstrap runs on a fresh DB.
const SEEDED_OWNER_PASSWORD = "Preview2025!";
const NEW_USER_PASSWORD = "VerifyTest1!";

try {
  /* -------- 1. Signup with a brand-new email -> zero credits -------- */
  const signup = await request("POST", "/api/me/signup", {
    full_name: "Verify Locked",
    email: newEmail,
    password: NEW_USER_PASSWORD,
    confirm_password: NEW_USER_PASSWORD,
  });
  assert(signup.status === 200, "signup new account returns 200", signup);
  assert(
    signup.json?.credits === 0,
    "new account starts with 0 credits (no welcome bonus; free-first model)",
    signup.json,
  );
  assert(signup.json?.role === "user", "new account role is 'user'");

  // Force the balance to 0 regardless of any future welcome-bonus change so
  // the assertions about zero-credit locked reports remain meaningful.
  await storage.setUserCredits(signup.json.id, 0);

  // Consume the free-first entitlement on a throwaway analysis so the unlock
  // under test in step 5 exercises the PAID (credit-spend) path rather than
  // claiming the free report.
  const freebie = await request("POST", "/api/analyses", {
    job_title: "Lighthouse Keeper",
    job_description:
      "Maintains the lighthouse and its optics, logs weather, and assists passing vessels.",
  });
  await request("POST", `/api/analyses/${freebie.json.id}/unlock`);

  const me = await request("GET", "/api/me");
  assert(me.json?.email === newEmail, "session points at the new user");
  assert(me.json?.credits === 0, "GET /api/me reports 0 credits after draining welcome credit");

  /* -------- 2. Zero-credit analysis: succeeds, comes back locked, body redacted -------- */
  const analyze = await request("POST", "/api/analyses", {
    job_title: "Heart Surgeon",
    job_description:
      "Performs cardiothoracic surgery on patients with complex cardiac disease, leads OR teams, and consults on high-stakes patient cases.",
  });
  assert(analyze.status === 200, "zero-credit user can POST /api/analyses", analyze);
  assert(analyze.json?.is_locked === true, "returned analysis has is_locked=true", analyze.json);
  assert(
    typeof analyze.json?.result_text === "string" && analyze.json.result_text.length > 0,
    "returned analysis still has a result_text (so headings/score render)",
  );
  assert(
    !bodyLooksReadable(String(analyze.json?.result_text ?? "")),
    "locked POST response contains no readable body content (only headings + redaction)",
    String(analyze.json?.result_text ?? "").slice(0, 300),
  );
  assert(
    /^#\s/m.test(String(analyze.json?.result_text ?? "")),
    "redacted body still includes the H1 report title",
  );
  assert(
    /^##\s/m.test(String(analyze.json?.result_text ?? "")),
    "redacted body still includes H2 section titles",
  );
  // The 'Current AI Impact on This Profession' section must remain
  // visible (as a heading) even on locked reports so the user can see
  // what is being redacted. Body content is still blocked.
  assert(
    /^##\s+Current AI Impact on This Profession\s*$/m.test(
      String(analyze.json?.result_text ?? ""),
    ),
    "locked report retains the 'Current AI Impact on This Profession' section heading",
  );
  assert(
    typeof analyze.json?.risk_score === "number" && analyze.json.risk_score > 0,
    "score/gauge data is still present on the locked record",
  );
  const analysisId = analyze.json?.id as number;

  /* -------- 3. GET endpoints also return redacted body for locked -------- */
  const single = await request("GET", `/api/analyses/${analysisId}`);
  assert(
    single.status === 200 && single.json?.is_locked === true,
    "GET /api/analyses/:id returns the locked record",
  );
  assert(
    !bodyLooksReadable(String(single.json?.result_text ?? "")),
    "GET /api/analyses/:id body is also redacted for the zero-credit owner",
    String(single.json?.result_text ?? "").slice(0, 300),
  );

  const list = await request("GET", "/api/analyses");
  const fromList = Array.isArray(list.json) ? list.json.find((a: any) => a.id === analysisId) : null;
  assert(
    fromList && fromList.is_locked === true,
    "GET /api/analyses list includes the locked record",
  );
  assert(
    fromList && !bodyLooksReadable(String(fromList.result_text ?? "")),
    "GET /api/analyses list body is also redacted",
  );

  /* -------- 4. Unlimited user gets the full unlocked body -------- */
  // Make sure the unlimited user exists with a known password, then sign in.
  const { hashPassword } = await import("../server/password");
  const existingUnlimited = await storage.getUserByEmail(unlimitedEmail);
  if (!existingUnlimited) {
    await storage.createUser({
      full_name: "Alex Roqueta",
      email: unlimitedEmail,
      role: "user",
      credits: 0,
      created_date: new Date().toISOString(),
      password_hash: hashPassword(SEEDED_OWNER_PASSWORD),
    });
  } else if (!existingUnlimited.password_hash) {
    await storage.setUserPassword(existingUnlimited.id, hashPassword(SEEDED_OWNER_PASSWORD));
  }
  await request("POST", "/api/me/logout");
  const signinUnlimited = await request("POST", "/api/me/signin", {
    email: unlimitedEmail,
    password: SEEDED_OWNER_PASSWORD,
  });
  assert(signinUnlimited.status === 200, "unlimited user can sign in", signinUnlimited);
  const unlimitedAnalyze = await request("POST", "/api/analyses", {
    job_title: "Senior Program Manager",
    job_description:
      "Owns cross-functional programs across cloud, IoT, and platform teams; coordinates roadmap, risk, and stakeholder communication.",
  });
  assert(
    unlimitedAnalyze.status === 200 && unlimitedAnalyze.json?.is_locked === false,
    "unlimited entitlement returns an unlocked analysis",
    unlimitedAnalyze.json,
  );
  assert(
    bodyLooksReadable(String(unlimitedAnalyze.json?.result_text ?? "")),
    "unlimited user's analysis body is fully readable",
  );
  // Verify the new role-specific 'Current AI Impact on This Profession'
  // section is present and contains actual narrative content, not just
  // the heading.
  const unlimitedText = String(unlimitedAnalyze.json?.result_text ?? "");
  assert(
    /^##\s+Current AI Impact on This Profession\s*$/m.test(unlimitedText),
    "unlocked report includes the 'Current AI Impact on This Profession' section heading",
  );
  const section = unlimitedText.split(/^##\s+Current AI Impact on This Profession\s*$/m)[1] ?? "";
  const sectionBody = section.split(/^##\s/m)[0] ?? "";
  assert(
    sectionBody.trim().length > 200 &&
      (sectionBody.match(/[A-Za-z]{3,}/g) ?? []).length > 30,
    "the AI impact section has substantive body content for the analyzed profession",
    sectionBody.slice(0, 200),
  );

  /* -------- 5. Promo code + unlock cycle for the zero-credit user -------- */
  await request("POST", "/api/me/logout");
  await request("POST", "/api/me/signin", {
    email: newEmail,
    password: NEW_USER_PASSWORD,
  });
  const beforeRedeem = await request("GET", "/api/me");
  const redeem = await request("POST", "/api/credits/redeem-code", { code: "10FREE" });
  assert(
    redeem.status === 200 && redeem.json?.credits_added === 10,
    "promo code 10FREE adds 10 credits",
    redeem.json,
  );
  const afterRedeem = await request("GET", "/api/me");
  assert(
    (afterRedeem.json?.credits ?? -1) === (beforeRedeem.json?.credits ?? 0) + 10,
    "promo code grant reflected on /api/me",
  );

  const unlock = await request("POST", `/api/analyses/${analysisId}/unlock`);
  assert(
    unlock.status === 200 && unlock.json?.is_locked === false,
    "unlock endpoint flips is_locked to false",
    unlock.json,
  );
  assert(
    bodyLooksReadable(String(unlock.json?.result_text ?? "")),
    "unlocked analysis body is fully readable after spending a credit",
  );
  const afterUnlock = await request("GET", "/api/me");
  assert(
    (afterUnlock.json?.credits ?? -1) === (afterRedeem.json?.credits ?? 0) - 1,
    "unlock decrements credits by exactly one",
    { before: afterRedeem.json?.credits, after: afterUnlock.json?.credits },
  );
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
