/* End-to-end verification for the lost-password / reset-code flow.
 *
 * Run with:  npx tsx script/verify-password-reset.ts
 *
 * Boots a real Express server against an isolated SQLite DB and asserts:
 *
 *   1. POST /api/me/forgot-password with an UNKNOWN email returns the
 *      SAME generic 200 response as the known-email path. No 404. No
 *      "user not found" message. No account enumeration.
 *   2. POST /api/me/forgot-password with a KNOWN email returns the
 *      generic 200 AND, in dev / preview mode, includes a `preview_code`
 *      field so internal testing can complete the flow without an
 *      email service.
 *   3. POST /api/me/reset-password with the WRONG code returns a
 *      generic 400 ("invalid or expired"). Old password still works.
 *   4. POST /api/me/reset-password with the CORRECT code, a new
 *      password, and matching confirm:
 *        - returns 200 with the user
 *        - signs the user in (GET /api/me succeeds)
 *        - old password no longer works
 *        - new password works
 *   5. A used reset code cannot be redeemed a second time.
 *   6. Email-only sign-in is rejected (defense against bypass).
 *   7. The unlimited entitlement for roqueta.alex@gmail.com survives a
 *      password reset \u2014 the same email re-issues credits=\u221e semantics
 *      via hasUnlimitedCredits() after reset + sign in.
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
const tmpDir = mkdtempSync(join(tmpdir(), "ousted-verify-reset-"));
const originalCwd = process.cwd();
process.chdir(tmpDir);

// Force preview-code exposure on regardless of NODE_ENV so the script
// is deterministic.
process.env.ALLOW_PREVIEW_RESET_CODE = "1";

// Make sure no real email gets dispatched from this script — point the
// email pipeline at a local capture so we can ALSO assert that the
// forgot-password route actually invokes the provider when one is set.
const sentEmails: Array<{ to: string; subject?: string; body?: string; auth?: string; from?: string }> = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init: any) => {
  const url = typeof input === "string" ? input : input?.url ?? "";
  if (typeof url === "string" && url.startsWith("https://api.resend.com/")) {
    let body: any = {};
    try {
      body = init?.body ? JSON.parse(String(init.body)) : {};
    } catch {
      body = { raw: String(init?.body ?? "") };
    }
    const headers = (init?.headers ?? {}) as Record<string, string>;
    sentEmails.push({
      to: Array.isArray(body?.to) ? body.to[0] : body?.to,
      subject: body?.subject,
      body: body?.text,
      auth: headers["Authorization"] ?? headers["authorization"],
      from: body?.from,
    });
    return new Response(JSON.stringify({ id: `mock_${Date.now()}` }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
  return originalFetch(input, init);
}) as typeof fetch;

// Configure the route's email pipeline to "resend" so selectEmailProvider()
// returns "resend" and our fetch stub captures the outbound request.
process.env.EMAIL_PROVIDER = "resend";
process.env.EMAIL_API_KEY = "test_resend_api_key_DO_NOT_LOG";
process.env.EMAIL_FROM = "CareerProof <noreply@careerproof.app>";

const { default: express } = await import("express");
const { createServer } = await import("node:http");
const { registerRoutes } = await import("../server/routes");
const { createSessionMiddleware } = await import("../server/session");
const storageMod = await import("../server/storage");
await storageMod.initStorage();
const { storage } = storageMod;
const { hasUnlimitedCredits } = await import("../shared/entitlements");

const app = express();
app.use(express.json({ limit: "20mb" }));
app.use(createSessionMiddleware());
const httpServer = createServer(app);
await registerRoutes(httpServer, app);

const PORT = 4798;
await new Promise<void>((resolve) => httpServer.listen(PORT, resolve));

const base = `http://127.0.0.1:${PORT}`;

/* Single shared cookie jar — this script verifies sequential auth
 * behavior (signin → /api/me → logout) and pre-sessions used a server
 * global, so a single client identity is what each step assumes. The
 * per-client isolation script (verify-session-isolation.ts) uses
 * separate jars per client. */
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

const stamp = Date.now();
const knownEmail = `verify_reset_${stamp}@example.com`;
const unknownEmail = `nobody_${stamp}@example.com`;
const ORIGINAL_PASSWORD = "OriginalPw1!";
const NEW_PASSWORD = "BrandNewPw2!";
const NEWER_PASSWORD = "EvenNewerPw3!";
const unlimitedEmail = "roqueta.alex@gmail.com";
const UNLIMITED_PASSWORD = "Preview2025!";
const UNLIMITED_NEW_PASSWORD = "RotatedPreview3!";

try {
  /* -------- Setup: real account to test against -------- */
  const signup = await request("POST", "/api/me/signup", {
    full_name: "Verify Reset",
    email: knownEmail,
    password: ORIGINAL_PASSWORD,
    confirm_password: ORIGINAL_PASSWORD,
  });
  assert(signup.status === 200, "test account created via signup", signup);
  await request("POST", "/api/me/logout");

  /* -------- 1. Forgot-password: unknown email -------- */
  const forgotUnknown = await request("POST", "/api/me/forgot-password", {
    email: unknownEmail,
  });
  assert(
    forgotUnknown.status === 200,
    "forgot-password for unknown email returns 200 (no enumeration)",
    forgotUnknown,
  );
  assert(
    typeof forgotUnknown.json?.message === "string" && forgotUnknown.json.message.length > 0,
    "forgot-password unknown returns a generic message",
  );
  assert(
    !("preview_code" in (forgotUnknown.json ?? {})),
    "forgot-password for unknown email does NOT include a preview_code",
    forgotUnknown.json,
  );

  /* -------- 2. Forgot-password: known email -------- */
  const forgotKnown = await request("POST", "/api/me/forgot-password", { email: knownEmail });
  assert(
    forgotKnown.status === 200 && typeof forgotKnown.json?.message === "string",
    "forgot-password for known email returns generic 200",
    forgotKnown,
  );
  assert(
    forgotKnown.json.message === forgotUnknown.json.message,
    "forgot-password generic message is identical for known and unknown emails",
    { known: forgotKnown.json?.message, unknown: forgotUnknown.json?.message },
  );
  const previewCode = forgotKnown.json?.preview_code as string | undefined;
  assert(
    typeof previewCode === "string" && /^\d{6}$/.test(previewCode),
    "preview build exposes a 6-digit preview_code for the known email",
    forgotKnown.json,
  );

  /* -------- 2a. Forgot-password actually invokes the email provider -------- */
  // The fetch stub above captures Resend API calls. The known-email
  // request above MUST have produced exactly one Resend invocation
  // addressed to that email. The unknown-email request MUST NOT have
  // produced one (no DB user → no send).
  const knownSends = sentEmails.filter((m) => m.to === knownEmail);
  assert(
    knownSends.length === 1,
    "forgot-password for known email invokes Resend exactly once",
    { captured: sentEmails.length, knownSends: knownSends.length },
  );
  if (knownSends.length === 1) {
    const send = knownSends[0]!;
    assert(
      typeof send.subject === "string" && /reset|password/i.test(send.subject ?? ""),
      "reset email subject mentions reset/password",
      { subject: send.subject },
    );
    assert(
      typeof send.body === "string" && send.body.includes(previewCode!),
      "reset email body includes the issued reset code",
    );
    assert(
      typeof send.auth === "string" && send.auth.startsWith("Bearer "),
      "Resend call uses Bearer auth header",
    );
    assert(
      typeof send.from === "string" && send.from.length > 0,
      "Resend call sets a from address from EMAIL_FROM",
    );
  }
  const unknownSends = sentEmails.filter((m) => m.to === unknownEmail);
  assert(
    unknownSends.length === 0,
    "forgot-password for unknown email does NOT invoke Resend",
    { unknownSends: unknownSends.length },
  );

  /* -------- 3. Reset with wrong code -------- */
  const wrongReset = await request("POST", "/api/me/reset-password", {
    email: knownEmail,
    code: "000000".padStart(6, "0") === previewCode ? "111111" : "000000",
    password: NEW_PASSWORD,
    confirm_password: NEW_PASSWORD,
  });
  assert(
    wrongReset.status === 400,
    "reset-password with wrong code returns 400",
    wrongReset,
  );
  assert(
    /invalid|expired/i.test(String(wrongReset.json?.error ?? "")),
    "reset-password with wrong code returns generic 'invalid or expired' error",
    wrongReset.json,
  );

  // Old password must still work after a failed reset attempt.
  const signinOldAfterFail = await request("POST", "/api/me/signin", {
    email: knownEmail,
    password: ORIGINAL_PASSWORD,
  });
  assert(
    signinOldAfterFail.status === 200,
    "old password still works after a failed reset attempt",
    signinOldAfterFail,
  );
  await request("POST", "/api/me/logout");

  /* -------- 4. Reset with correct code -------- */
  const reset = await request("POST", "/api/me/reset-password", {
    email: knownEmail,
    code: previewCode!,
    password: NEW_PASSWORD,
    confirm_password: NEW_PASSWORD,
  });
  assert(reset.status === 200, "reset-password with correct code returns 200", reset);
  assert(reset.json?.email === knownEmail, "reset returns the user object");
  assert(
    !("password_hash" in (reset.json ?? {})),
    "reset response does NOT leak password_hash",
  );

  const meAfterReset = await request("GET", "/api/me");
  assert(
    meAfterReset.status === 200 && meAfterReset.json?.email === knownEmail,
    "user is signed in immediately after reset (GET /api/me)",
    meAfterReset,
  );
  await request("POST", "/api/me/logout");

  // Old password must FAIL.
  const signinOld = await request("POST", "/api/me/signin", {
    email: knownEmail,
    password: ORIGINAL_PASSWORD,
  });
  assert(
    signinOld.status === 401,
    "old password no longer works after reset",
    signinOld,
  );

  // New password must WORK.
  const signinNew = await request("POST", "/api/me/signin", {
    email: knownEmail,
    password: NEW_PASSWORD,
  });
  assert(
    signinNew.status === 200,
    "new password works after reset",
    signinNew,
  );
  await request("POST", "/api/me/logout");

  /* -------- 5. Reused code is rejected -------- */
  const reuse = await request("POST", "/api/me/reset-password", {
    email: knownEmail,
    code: previewCode!,
    password: NEWER_PASSWORD,
    confirm_password: NEWER_PASSWORD,
  });
  assert(
    reuse.status === 400,
    "previously-redeemed reset code cannot be used a second time",
    reuse,
  );
  // The just-redeemed (now invalid) attempt must not have changed the
  // password \u2014 NEW_PASSWORD should still sign in, NEWER_PASSWORD should not.
  const signinNewerAfterReuse = await request("POST", "/api/me/signin", {
    email: knownEmail,
    password: NEWER_PASSWORD,
  });
  assert(
    signinNewerAfterReuse.status === 401,
    "second-attempt password did NOT take effect after the reused code was rejected",
  );
  const signinStillNew = await request("POST", "/api/me/signin", {
    email: knownEmail,
    password: NEW_PASSWORD,
  });
  assert(
    signinStillNew.status === 200,
    "currently-valid password still signs in after the reuse rejection",
  );
  await request("POST", "/api/me/logout");

  /* -------- 6. Email-only sign-in / reset bypass is rejected -------- */
  const emailOnly = await request("POST", "/api/me/signin", { email: knownEmail });
  assert(
    emailOnly.status === 400 || emailOnly.status === 401,
    "sign-in without a password is rejected",
    emailOnly,
  );
  const resetMissingPw = await request("POST", "/api/me/reset-password", {
    email: knownEmail,
    code: "123456",
  });
  assert(
    resetMissingPw.status === 400,
    "reset-password without a new password is rejected",
    resetMissingPw,
  );
  // Validate that a known-good code cannot be redeemed without a new
  // password (defense against using the reset endpoint as a sign-in
  // bypass). Generate a fresh code, then try to use it with no password.
  const freshForgot = await request("POST", "/api/me/forgot-password", { email: knownEmail });
  const freshCode = freshForgot.json?.preview_code as string;
  const resetBypass = await request("POST", "/api/me/reset-password", {
    email: knownEmail,
    code: freshCode,
  });
  assert(
    resetBypass.status === 400,
    "reset-password with a valid code but NO new password is rejected (no sign-in bypass)",
    resetBypass,
  );
  // After the rejected bypass attempt, /api/me must still be 401 (the
  // code didn't sign anyone in).
  const meAfterBypass = await request("GET", "/api/me");
  assert(
    meAfterBypass.status === 401,
    "no session was created by the bypass attempt",
    meAfterBypass,
  );

  /* -------- 7. Unlimited entitlement survives reset -------- */
  // Seed unlimited account if needed (fresh DB)
  const { hashPassword } = await import("../server/password");
  let owner = await storage.getUserByEmail(unlimitedEmail);
  if (!owner) {
    owner = await storage.createUser({
      full_name: "Alex Roqueta",
      email: unlimitedEmail,
      role: "user",
      credits: 0,
      created_date: new Date().toISOString(),
      password_hash: hashPassword(UNLIMITED_PASSWORD),
    });
  } else if (!owner.password_hash) {
    await storage.setUserPassword(owner.id, hashPassword(UNLIMITED_PASSWORD));
  }

  const ownerForgot = await request("POST", "/api/me/forgot-password", { email: unlimitedEmail });
  const ownerCode = ownerForgot.json?.preview_code as string;
  assert(
    /^\d{6}$/.test(String(ownerCode)),
    "unlimited account can request a reset code",
  );
  const ownerReset = await request("POST", "/api/me/reset-password", {
    email: unlimitedEmail,
    code: ownerCode,
    password: UNLIMITED_NEW_PASSWORD,
    confirm_password: UNLIMITED_NEW_PASSWORD,
  });
  assert(ownerReset.status === 200, "unlimited account password reset succeeds", ownerReset);
  // Auto-signed-in after reset. Entitlement must still be unlimited.
  const ownerMe = await request("GET", "/api/me");
  assert(
    ownerMe.status === 200 && ownerMe.json?.email === unlimitedEmail,
    "unlimited account is signed in after reset",
  );
  assert(
    hasUnlimitedCredits(ownerMe.json?.email, ownerMe.json?.role),
    "hasUnlimitedCredits() still returns true after password reset",
    ownerMe.json,
  );
  // Verify the unlimited user can still run an analysis with an unlocked body.
  const ownerAnalyze = await request("POST", "/api/analyses", {
    job_title: "Senior Program Manager",
    job_description:
      "Owns cross-functional programs across cloud, IoT, and platform teams; coordinates roadmap, risk, and stakeholder communication.",
  });
  assert(
    ownerAnalyze.status === 200 && ownerAnalyze.json?.is_locked === false,
    "unlimited account still produces unlocked analyses after password reset",
    ownerAnalyze.json,
  );

  // Old unlimited password must FAIL.
  await request("POST", "/api/me/logout");
  const oldOwnerLogin = await request("POST", "/api/me/signin", {
    email: unlimitedEmail,
    password: UNLIMITED_PASSWORD,
  });
  assert(
    oldOwnerLogin.status === 401,
    "old preview password for unlimited account no longer works after reset",
    oldOwnerLogin,
  );
  const newOwnerLogin = await request("POST", "/api/me/signin", {
    email: unlimitedEmail,
    password: UNLIMITED_NEW_PASSWORD,
  });
  assert(
    newOwnerLogin.status === 200,
    "new password for unlimited account works after reset",
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
console.log(`\nAll password-reset verification cases passed.`);
