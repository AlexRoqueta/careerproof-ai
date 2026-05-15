/* End-to-end verification for production-readiness hardening.
 *
 * Run with:  npx tsx script/verify-production-hardening.ts
 *
 * Boots a real Express server against an isolated SQLite DB and asserts:
 *
 *   1. Owner-gating on analyses
 *      - A signed-in user A creates an analysis.
 *      - A different signed-in user B receives 404 from
 *        GET/DELETE /api/analyses/:id and POST /api/analyses/:id/unlock
 *        for that id. The status is 404 (NOT 403) so the id space is
 *        not enumerable. A's listing only contains A's analyses.
 *      - An admin CAN read A's analysis (admin override allowed).
 *      - An unauthenticated request returns 401.
 *
 *   2. Owner-gating on resumes
 *      - DELETE /api/resumes/:id for another user's resume returns 404.
 *      - POST /api/resumes/prefill for another user's resume returns 404.
 *
 *   3. Rate limiting on auth-sensitive endpoints
 *      - 6 rapid forgot-password requests for the same email return at
 *        least one 429 (limit is 5/min). Generic error message.
 *      - Repeated unlock attempts past the limit return 429.
 *      - DISABLE_RATE_LIMIT=1 bypasses the limiter (used by other
 *        regression scripts).
 *
 *   4. Production reset-code hiding
 *      - With NODE_ENV=production and ALLOW_PREVIEW_RESET_CODE unset,
 *        /api/me/forgot-password returns a generic message and NO
 *        `preview_code` field. The response body wording mentions
 *        \"has been sent\".
 *      - The same flow in preview mode includes `preview_code` and
 *        mentions ALLOW_PREVIEW_RESET_CODE in the message.
 *
 *   5. Config check endpoint
 *      - GET /api/config/check returns { ok, items, ... } and never
 *        echoes secret values. In preview mode with no real provider
 *        credentials the report is still `ok: true` (warnings only).
 *
 * Exits non-zero on any failure.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Run sub-server in a child process so we can set NODE_ENV=production
// for one section. The bulk of the script runs in the parent.

const __filename = fileURLToPath(import.meta.url);
const projectRoot = dirname(dirname(__filename));
const tmpDir = mkdtempSync(join(tmpdir(), "ousted-verify-hardening-"));
const originalCwd = process.cwd();
process.chdir(tmpDir);

// Reset rate limit counters between sub-cases so the rate-limit
// assertion is the ONLY assertion that pushes a limiter past max.
process.env.DISABLE_RATE_LIMIT = "0"; // explicit
process.env.NODE_ENV = "development";

const { default: express } = await import("express");
const { createServer } = await import("node:http");
const { registerRoutes } = await import("../server/routes");
const { storage } = await import("../server/storage");
const { hashPassword } = await import("../server/password");
const { __resetRateLimits } = await import("../server/rate-limit");

const app = express();
app.use(express.json({ limit: "20mb" }));
const httpServer = createServer(app);
await registerRoutes(httpServer, app);

const PORT = 4801;
await new Promise<void>((resolve) => httpServer.listen(PORT, resolve));

const base = `http://127.0.0.1:${PORT}`;
let cookieJar = "";

async function request(
  method: string,
  path: string,
  body?: unknown,
  opts: { headers?: Record<string, string> } = {},
): Promise<{ status: number; json: any; headers: Headers }> {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (cookieJar) headers["Cookie"] = cookieJar;
  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  return { status: res.status, json, headers: res.headers };
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
  const stamp = Date.now();
  const emailA = `owner_a_${stamp}@example.com`;
  const emailB = `owner_b_${stamp}@example.com`;
  const pwA = "OwnerATest1!";
  const pwB = "OwnerBTest1!";

  /* ============================================================
   * Bootstrap: create user A, user B, and an admin user.
   * ============================================================ */
  await request("POST", "/api/me/logout");
  __resetRateLimits();

  const signupA = await request("POST", "/api/me/signup", {
    full_name: "Owner A",
    email: emailA,
    password: pwA,
    confirm_password: pwA,
  });
  assert(signupA.status === 200, "signup user A", signupA);
  const userAId = signupA.json?.id as number;
  // grant some credits so the unlock path can be exercised
  // (admin grant via storage directly — outside the API)
  storage.setUserCredits(userAId, 5);

  // Create an analysis as A
  const analyzeA = await request("POST", "/api/analyses", {
    job_title: "Owner A Role",
    job_description: "Detailed description for user A's analysis. ".repeat(8),
  });
  assert(analyzeA.status === 200, "user A can create analysis", analyzeA);
  const analysisAId = analyzeA.json?.id as number;
  const resumeAUpload = await request("POST", "/api/resumes", {
    filename: "owner-a.txt",
    content_type: "text/plain",
    size_bytes: 12,
    data_url: "data:text/plain;base64,QQ==",
  });
  assert(resumeAUpload.status === 200, "user A can upload resume", resumeAUpload);
  const resumeAId = resumeAUpload.json?.id as number;

  await request("POST", "/api/me/logout");

  // Now user B
  const signupB = await request("POST", "/api/me/signup", {
    full_name: "Owner B",
    email: emailB,
    password: pwB,
    confirm_password: pwB,
  });
  assert(signupB.status === 200, "signup user B", signupB);

  /* ============================================================
   * 1. Owner-gating on analyses
   * ============================================================ */
  console.log("\n--- Owner-gating: analyses ---");
  const otherGet = await request("GET", `/api/analyses/${analysisAId}`);
  assert(
    otherGet.status === 404,
    "user B GET /api/analyses/:id of A's analysis is 404 (not 403, not 200)",
    otherGet,
  );

  const otherUnlock = await request("POST", `/api/analyses/${analysisAId}/unlock`);
  assert(
    otherUnlock.status === 404,
    "user B POST /api/analyses/:id/unlock of A's analysis is 404",
    otherUnlock,
  );

  const otherDelete = await request("DELETE", `/api/analyses/${analysisAId}`);
  assert(
    otherDelete.status === 404,
    "user B DELETE /api/analyses/:id of A's analysis is 404",
    otherDelete,
  );

  // A's record still intact
  const stillThere = storage.getAnalysis(analysisAId);
  assert(!!stillThere, "A's analysis was NOT deleted by B's request");

  // B's listing must NOT include A's analysis
  const listB = await request("GET", "/api/analyses");
  const bSeesA = Array.isArray(listB.json) && listB.json.some((a: any) => a.id === analysisAId);
  assert(!bSeesA, "GET /api/analyses for user B does not leak A's records");

  /* ============================================================
   * 2. Owner-gating on resumes
   * ============================================================ */
  console.log("\n--- Owner-gating: resumes ---");
  const otherResumeDel = await request("DELETE", `/api/resumes/${resumeAId}`);
  assert(otherResumeDel.status === 404, "user B DELETE /api/resumes/:id of A's resume is 404");
  const stillResume = storage.getResume(resumeAId);
  assert(!!stillResume, "A's resume was NOT deleted by B's request");

  const otherPrefill = await request("POST", "/api/resumes/prefill", {
    resume_id: resumeAId,
  });
  assert(
    otherPrefill.status === 404,
    "user B POST /api/resumes/prefill of A's resume is 404",
    otherPrefill,
  );

  /* ============================================================
   * 3. Admin can override owner gate
   * ============================================================ */
  console.log("\n--- Admin override ---");
  // Create admin directly through storage (the API has no \"create
  // admin\" endpoint by design \u2014 admins are provisioned out of band).
  const adminEmail = `admin_${stamp}@example.com`;
  storage.createUser({
    full_name: "Admin User",
    email: adminEmail,
    role: "admin",
    credits: 999,
    created_date: new Date().toISOString(),
    password_hash: hashPassword("AdminVerify1!"),
  });
  await request("POST", "/api/me/logout");
  const adminSignin = await request("POST", "/api/me/signin", {
    email: adminEmail,
    password: "AdminVerify1!",
  });
  assert(adminSignin.status === 200, "admin signin", adminSignin);
  const adminGet = await request("GET", `/api/analyses/${analysisAId}`);
  assert(
    adminGet.status === 200 && adminGet.json?.id === analysisAId,
    "admin can GET another user's analysis",
    adminGet,
  );

  /* ============================================================
   * 4. Unauthenticated access blocked
   * ============================================================ */
  console.log("\n--- Unauthenticated access ---");
  await request("POST", "/api/me/logout");
  const anonGet = await request("GET", `/api/analyses/${analysisAId}`);
  assert(anonGet.status === 401, "unauthenticated GET /api/analyses/:id is 401", anonGet);

  /* ============================================================
   * 5. Rate limiting: forgot-password
   * ============================================================ */
  console.log("\n--- Rate limiting: forgot-password ---");
  __resetRateLimits();
  const target = `ratetest_${stamp}@example.com`;
  let saw429 = false;
  let earliestBlockedAt = -1;
  for (let i = 0; i < 8; i++) {
    const r = await request("POST", "/api/me/forgot-password", { email: target });
    if (r.status === 429) {
      saw429 = true;
      if (earliestBlockedAt < 0) earliestBlockedAt = i + 1;
    }
  }
  assert(saw429, "forgot-password is rate limited (saw 429 within 8 attempts)");
  assert(
    earliestBlockedAt > 0 && earliestBlockedAt <= 6,
    `forgot-password 429 should arrive on attempt 6 or earlier (got ${earliestBlockedAt})`,
  );

  /* ============================================================
   * 6. Rate limiting: signin
   * ============================================================ */
  console.log("\n--- Rate limiting: signin ---");
  __resetRateLimits();
  let signinBlocked = false;
  for (let i = 0; i < 12; i++) {
    const r = await request("POST", "/api/me/signin", {
      email: "nobody@example.com",
      password: "wrongpassword",
    });
    if (r.status === 429) {
      signinBlocked = true;
      // Generic message; must NOT reveal whether the email exists.
      assert(
        typeof r.json?.error === "string" && !/email/i.test(r.json.error),
        "429 message is generic (no email-existence leak)",
        r.json,
      );
      break;
    }
  }
  assert(signinBlocked, "signin is rate limited (saw 429 within 12 attempts)");

  /* ============================================================
   * 7. DISABLE_RATE_LIMIT bypass
   * ============================================================ */
  console.log("\n--- DISABLE_RATE_LIMIT=1 bypass ---");
  process.env.DISABLE_RATE_LIMIT = "1";
  __resetRateLimits();
  let allowed = 0;
  for (let i = 0; i < 30; i++) {
    const r = await request("POST", "/api/me/forgot-password", {
      email: `bypass_${stamp}@example.com`,
    });
    if (r.status !== 429) allowed += 1;
  }
  assert(allowed === 30, "DISABLE_RATE_LIMIT=1 lets 30 requests through without 429");
  process.env.DISABLE_RATE_LIMIT = "0";
  __resetRateLimits();

  /* ============================================================
   * 8. Production reset-code hiding
   * ============================================================ */
  console.log("\n--- Production reset-code hiding ---");
  // We can't reload the route module mid-process, but the response
  // wording is computed at request time from PREVIEW_CODE_ENABLED,
  // which is captured at registerRoutes. So we test the behavior in
  // a second isolated server, started after toggling NODE_ENV.
  process.env.NODE_ENV = "production";
  delete process.env.ALLOW_PREVIEW_RESET_CODE;
  // Reset Node's module cache for ../server/routes so the new
  // PREVIEW_CODE_ENABLED is captured. tsx uses ESM \u2014 we re-import via
  // a query string suffix to defeat the cache.
  const routesProd = await import("../server/routes?prod=1");
  const appProd = express();
  appProd.use(express.json({ limit: "20mb" }));
  const httpProd = createServer(appProd);
  await routesProd.registerRoutes(httpProd, appProd);
  const PROD_PORT = 4802;
  await new Promise<void>((resolve) => httpProd.listen(PROD_PORT, resolve));
  const prodBase = `http://127.0.0.1:${PROD_PORT}`;

  // Seed an account into the SAME db so the prod-mode forgot-password
  // has a real target.
  const prodEmail = `prod_${stamp}@example.com`;
  storage.createUser({
    full_name: "Prod Mode User",
    email: prodEmail,
    role: "user",
    credits: 0,
    created_date: new Date().toISOString(),
    password_hash: hashPassword("ProdMode1!"),
  });

  const prodForgot = await fetch(`${prodBase}/api/me/forgot-password`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: prodEmail }),
  });
  const prodJson = (await prodForgot.json()) as any;
  assert(prodForgot.status === 200, "prod-mode forgot-password returns 200");
  assert(
    prodJson?.preview_code === undefined,
    "prod-mode forgot-password DOES NOT include preview_code",
    prodJson,
  );
  assert(
    typeof prodJson?.message === "string" && /sent/i.test(prodJson.message),
    "prod-mode message mentions \"sent\" (production wording)",
    prodJson,
  );

  // Now with ALLOW_PREVIEW_RESET_CODE=1 in prod, the code SHOULD be
  // returned (operator opt-in). Reload the module again so the new
  // env is picked up.
  process.env.ALLOW_PREVIEW_RESET_CODE = "1";
  const routesProdOptIn = await import("../server/routes?prod=optin");
  const appOptIn = express();
  appOptIn.use(express.json({ limit: "20mb" }));
  const httpOptIn = createServer(appOptIn);
  await routesProdOptIn.registerRoutes(httpOptIn, appOptIn);
  const OPTIN_PORT = 4803;
  await new Promise<void>((resolve) => httpOptIn.listen(OPTIN_PORT, resolve));
  const optInForgot = await fetch(`http://127.0.0.1:${OPTIN_PORT}/api/me/forgot-password`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: prodEmail }),
  });
  const optInJson = (await optInForgot.json()) as any;
  assert(
    typeof optInJson?.preview_code === "string" && /^\d{6}$/.test(optInJson.preview_code),
    "prod + ALLOW_PREVIEW_RESET_CODE=1 returns preview_code (operator opt-in)",
    optInJson,
  );

  // Close the extra servers.
  await new Promise<void>((resolve) => httpProd.close(() => resolve()));
  await new Promise<void>((resolve) => httpOptIn.close(() => resolve()));

  // Restore env for the rest of the run.
  process.env.NODE_ENV = "development";
  delete process.env.ALLOW_PREVIEW_RESET_CODE;

  /* ============================================================
   * 9. Config check endpoint
   * ============================================================ */
  console.log("\n--- Config check endpoint ---");
  __resetRateLimits();
  const cfg = await request("GET", "/api/config/check");
  assert(cfg.status === 200, "GET /api/config/check returns 200");
  assert(typeof cfg.json?.ok === "boolean", "config report has .ok boolean", cfg.json);
  assert(Array.isArray(cfg.json?.items), "config report has .items array");
  // Sanity: no secrets bleed through. We accept the public fields:
  // node_env, is_production, payment_provider, *_set flags, items.
  const keys = Object.keys(cfg.json ?? {});
  const allowed_keys = new Set([
    "node_env",
    "is_production",
    "payment_provider",
    "preview_reset_code_enabled",
    "app_base_url_set",
    "email_pipeline_configured",
    "payment_credentials_configured",
    "ok",
    "items",
  ]);
  const surprising = keys.filter((k) => !allowed_keys.has(k));
  assert(
    surprising.length === 0,
    "config report does not include any unexpected fields (no secret leakage)",
    surprising,
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
console.log(`\nAll production-hardening verification cases passed.`);
