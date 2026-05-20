/* End-to-end verification for the provider-agnostic payments phase.
 *
 * Run with:  npx tsx script/verify-payments-credits.ts
 *
 * Boots a real Express server against an isolated SQLite DB and asserts:
 *
 *   1. GET /api/payments/packages returns the canonical CREDIT_PACKAGES
 *      catalog and the active provider metadata.
 *   2. POST /api/payments/create-checkout for the "standard_3" package
 *      returns a loopback checkout_url with signed session_id + token,
 *      the marker preview=true, and provider="preview".
 *   3. POST /api/payments/complete-checkout with the returned
 *      session_id + token grants exactly 3 credits, appends a ledger
 *      row with reason='purchase', and a second POST with the SAME
 *      session_id is idempotent (no double-credit, already_processed).
 *   4. POST /api/payments/complete-checkout with a tampered token /
 *      mismatched session_id is rejected and grants no credits.
 *   5. POST /api/credits/redeem-code "10FREE" works for a fresh user
 *      (grants 10, ledger row 'promo'), is case-insensitive
 *      ("10free" and " 10Free " redeem the same way) BUT only one
 *      redemption ever lands on the account; subsequent attempts get
 *      409 with reason='already_redeemed' and the balance is unchanged.
 *   6. POST /api/analyses/:id/unlock with insufficient credits returns
 *      402 with reason='insufficient_credits' and no ledger row is
 *      written. After redeeming 10FREE, unlock succeeds, decrements
 *      credits by exactly 1, and appends a ledger row with reason=
 *      'unlock_spend' and reference='analysis:<id>'.
 *   7. GET /api/credits/transactions returns the full ledger in
 *      reverse-chronological order with the expected reasons + deltas
 *      + running balance_after values.
 *   8. Admin "set credits" appends a single admin_adjustment row with
 *      the correct delta.
 *   9. Unlimited entitlement for roqueta.alex@gmail.com bypasses
 *      credit deduction on unlock and writes NO ledger row (entitlement
 *      is independent of the credit balance).
 *
 * Exits non-zero on any failure so the script can gate CI.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const projectRoot = dirname(dirname(__filename));
const tmpDir = mkdtempSync(join(tmpdir(), "ousted-verify-payments-"));
const originalCwd = process.cwd();
process.chdir(tmpDir);

const { default: express } = await import("express");
const { createServer } = await import("node:http");
const { registerRoutes } = await import("../server/routes");
const { createSessionMiddleware } = await import("../server/session");
const storageMod = await import("../server/storage");
await storageMod.initStorage();
const { storage, _setAnalysisLockedForTest } = storageMod;
const { hashPassword } = await import("../server/password");

const app = express();
app.use(express.json({ limit: "20mb" }));
app.use(createSessionMiddleware());
const httpServer = createServer(app);
await registerRoutes(httpServer, app);

const PORT = 4812;
await new Promise<void>((resolve) => httpServer.listen(PORT, resolve));

const base = `http://127.0.0.1:${PORT}`;

/* Single shared cookie jar. The script switches identities via the
 * standard logout → signin/signup flow, which destroys the previous
 * session record before establishing a new one. */
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
        `        detail: ${
          typeof detail === "string" ? detail : JSON.stringify(detail).slice(0, 400)
        }`,
      );
    }
  }
}

const stamp = Date.now();
const buyerEmail = `verify_buyer_${stamp}@example.com`;
const buyerPassword = "PayVerify1!";
const adminEmail = "admin@example.com";
const adminPassword = "AdminPreview2025!";
const unlimitedEmail = "roqueta.alex@gmail.com";
const unlimitedPassword = "Preview2025!";

try {
  /* ---------- 1. Packages endpoint ---------- */
  const pkgs = await request("GET", "/api/payments/packages");
  assert(pkgs.status === 200, "GET /api/payments/packages returns 200", pkgs);
  assert(
    Array.isArray(pkgs.json?.packages) && pkgs.json.packages.length === 3,
    "packages catalog has 3 entries",
    pkgs.json,
  );
  const ids = (pkgs.json?.packages ?? []).map((p: any) => p.id).sort();
  assert(
    JSON.stringify(ids) === JSON.stringify(["standard_3", "starter_1", "value_5"]),
    "package ids match the canonical catalog",
    ids,
  );
  assert(
    pkgs.json?.provider?.is_preview === true && pkgs.json?.provider?.name === "preview",
    "active provider is the preview/test provider",
    pkgs.json?.provider,
  );
  const standard = pkgs.json.packages.find((p: any) => p.id === "standard_3");
  assert(standard?.credits === 3, "standard_3 grants 3 credits");
  assert(standard?.popular === true, "standard_3 is flagged popular");

  /* ---------- 2. Buyer signup + create-checkout ---------- */
  const signup = await request("POST", "/api/me/signup", {
    full_name: "Verify Buyer",
    email: buyerEmail,
    password: buyerPassword,
    confirm_password: buyerPassword,
  });
  assert(
    signup.status === 200 && signup.json?.credits === 1,
    "buyer signs up with 1 welcome credit",
    signup,
  );
  // Drain the welcome credit directly so the rest of this script
  // verifies the from-zero purchase / promo / unlock flows.
  await storage.setUserCredits(signup.json.id, 0);

  const cco = await request("POST", "/api/payments/create-checkout", {
    package_id: "standard_3",
  });
  assert(cco.status === 200, "create-checkout returns 200", cco);
  assert(cco.json?.preview === true, "create-checkout flags preview=true");
  assert(cco.json?.provider === "preview", "create-checkout reports provider=preview");
  assert(
    typeof cco.json?.checkout_url === "string" && cco.json.checkout_url.includes("status=preview-success"),
    "checkout_url loops back with status=preview-success",
    cco.json?.checkout_url,
  );
  const url = new URL(cco.json.checkout_url);
  const session_id = url.searchParams.get("session_id") ?? "";
  const token = url.searchParams.get("token") ?? "";
  const package_id = url.searchParams.get("package_id") ?? "";
  assert(session_id.startsWith("preview_"), "session_id is preview-prefixed");
  assert(token.length === 64, "token is a 64-char hex signature");
  assert(package_id === "standard_3", "checkout_url carries the package id");

  /* ---------- 3. Tampered token rejected ---------- */
  const tampered = token.slice(0, -2) + (token.endsWith("00") ? "11" : "00");
  const bad = await request("POST", "/api/payments/complete-checkout", {
    session_id,
    token: tampered,
  });
  assert(bad.status === 400, "tampered token rejected with 400", bad);
  const meAfterBad = await request("GET", "/api/me");
  assert(meAfterBad.json?.credits === 0, "tampered token did not grant credits");

  /* ---------- 4. Successful checkout completion ---------- */
  const complete = await request("POST", "/api/payments/complete-checkout", {
    session_id,
    token,
  });
  assert(complete.status === 200, "valid completion returns 200", complete);
  assert(
    complete.json?.credits_added === 3 && complete.json?.user?.credits === 3,
    "valid completion grants exactly 3 credits",
    complete.json,
  );
  assert(complete.json?.already_processed === false, "first completion is not already_processed");

  /* ---------- 5. Idempotent re-completion ---------- */
  const replay = await request("POST", "/api/payments/complete-checkout", {
    session_id,
    token,
  });
  assert(
    replay.status === 200 && replay.json?.already_processed === true && replay.json?.credits_added === 0,
    "duplicate completion is idempotent (already_processed=true, 0 added)",
    replay.json,
  );
  const meAfterReplay = await request("GET", "/api/me");
  assert(meAfterReplay.json?.credits === 3, "duplicate completion did not double-grant");

  /* ---------- 6. Ledger contains the purchase row ---------- */
  const txs1 = await request("GET", "/api/credits/transactions");
  assert(txs1.status === 200, "transactions endpoint returns 200", txs1);
  const purchaseRow = (txs1.json?.transactions ?? []).find(
    (t: any) => t.reason === "purchase",
  );
  assert(purchaseRow, "ledger contains a purchase row after completion", txs1.json);
  assert(purchaseRow?.amount_delta === 3, "purchase row delta is +3");
  assert(purchaseRow?.balance_after === 3, "purchase row balance_after is 3");
  assert(purchaseRow?.provider === "preview", "purchase row records provider=preview");
  assert(
    typeof purchaseRow?.reference === "string" && purchaseRow.reference.includes(session_id),
    "purchase row reference includes the session id (idempotency key)",
    purchaseRow?.reference,
  );

  /* ---------- 7. Promo code: case-insensitive, single redemption ---------- */
  // Fresh user for the promo redemption assertions so the buyer's
  // earlier state doesn't interfere.
  const promoEmail = `verify_promo_${stamp}@example.com`;
  const promoPassword = "PromoVerify1!";
  await request("POST", "/api/me/logout");
  const promoSignup = await request("POST", "/api/me/signup", {
    full_name: "Verify Promo",
    email: promoEmail,
    password: promoPassword,
    confirm_password: promoPassword,
  });
  // Drain the welcome credit so the +10 promo lands on a 0 base, matching
  // the original test's "balance is exactly 10" expectation.
  await storage.setUserCredits(promoSignup.json.id, 0);
  // Mixed-case input is accepted.
  const redeemMixed = await request("POST", "/api/credits/redeem-code", { code: " 10Free " });
  assert(
    redeemMixed.status === 200 && redeemMixed.json?.credits_added === 10,
    "promo code accepted with mixed-case and surrounding whitespace",
    redeemMixed.json,
  );
  // Lowercase replay is rejected as already_redeemed.
  const redeemLower = await request("POST", "/api/credits/redeem-code", { code: "10free" });
  assert(
    redeemLower.status === 409 && redeemLower.json?.reason === "already_redeemed",
    "second redemption (lowercase) is rejected with 409 already_redeemed",
    redeemLower.json,
  );
  // Exact-case replay also rejected.
  const redeemExact = await request("POST", "/api/credits/redeem-code", { code: "10FREE" });
  assert(
    redeemExact.status === 409 && redeemExact.json?.reason === "already_redeemed",
    "third redemption (exact case) is rejected with 409 already_redeemed",
    redeemExact.json,
  );
  const promoMe = await request("GET", "/api/me");
  assert(promoMe.json?.credits === 10, "promo balance is exactly 10 after repeated attempts");
  // Garbage code returns 400 with a clear error.
  const redeemBad = await request("POST", "/api/credits/redeem-code", { code: "NOPE2025" });
  assert(
    redeemBad.status === 400 && typeof redeemBad.json?.error === "string",
    "unknown promo code returns 400 with an error message",
    redeemBad.json,
  );
  // Ledger reflects exactly ONE promo row.
  const promoTxs = await request("GET", "/api/credits/transactions");
  const promoRows = (promoTxs.json?.transactions ?? []).filter((t: any) => t.reason === "promo");
  assert(promoRows.length === 1, "exactly one promo ledger row after multiple attempts", promoRows);
  assert(
    promoRows[0]?.amount_delta === 10 && promoRows[0]?.balance_after === 10,
    "promo ledger row records +10 with balance_after 10",
  );

  /* ---------- 8. Unlock spend / insufficient credits ---------- */
  // First create an analysis as a zero-credit user so it is locked.
  const lockedEmail = `verify_locked_${stamp}@example.com`;
  const lockedPassword = "LockedVerify1!";
  await request("POST", "/api/me/logout");
  const lockedSignup = await request("POST", "/api/me/signup", {
    full_name: "Verify Locked",
    email: lockedEmail,
    password: lockedPassword,
    confirm_password: lockedPassword,
  });
  // Drain the welcome credit so the analysis is created locked (the
  // assertion that follows requires zero credits at creation time).
  await storage.setUserCredits(lockedSignup.json.id, 0);
  const analyzed = await request("POST", "/api/analyses", {
    job_title: "Heart Surgeon",
    job_description:
      "Performs cardiothoracic surgery on patients with complex cardiac disease, leads OR teams.",
  });
  assert(
    analyzed.status === 200 && analyzed.json?.is_locked === true,
    "zero-credit analysis is created locked",
  );
  const analysisId = analyzed.json.id as number;
  // Unlock with 0 credits -> 402.
  const insuf = await request("POST", `/api/analyses/${analysisId}/unlock`);
  assert(
    insuf.status === 402 && insuf.json?.reason === "insufficient_credits",
    "unlock without credits returns 402 with reason='insufficient_credits'",
    insuf.json,
  );
  // No ledger row should have been written.
  const beforeUnlockTxs = await request("GET", "/api/credits/transactions");
  const spendsBefore = (beforeUnlockTxs.json?.transactions ?? []).filter(
    (t: any) => t.reason === "unlock_spend",
  );
  assert(spendsBefore.length === 0, "no unlock_spend ledger row was written on the 402 path");

  // Redeem promo to get credits, then unlock.
  const redeem = await request("POST", "/api/credits/redeem-code", { code: "10FREE" });
  assert(redeem.status === 200 && redeem.json?.credits_added === 10, "promo grants 10 credits before unlock");
  const unlock = await request("POST", `/api/analyses/${analysisId}/unlock`);
  assert(
    unlock.status === 200 && unlock.json?.is_locked === false,
    "unlock succeeds once credits are available",
    unlock.json,
  );
  const meAfterUnlock = await request("GET", "/api/me");
  assert(meAfterUnlock.json?.credits === 9, "unlock decremented credits by exactly 1 (10 -> 9)");
  const lockedUserTxs = await request("GET", "/api/credits/transactions");
  const spendRows = (lockedUserTxs.json?.transactions ?? []).filter(
    (t: any) => t.reason === "unlock_spend",
  );
  assert(spendRows.length === 1, "exactly one unlock_spend ledger row after unlocking");
  assert(spendRows[0]?.amount_delta === -1, "unlock_spend row delta is -1");
  assert(
    spendRows[0]?.reference === `analysis:${analysisId}`,
    "unlock_spend reference identifies the analysis",
    spendRows[0]?.reference,
  );
  assert(spendRows[0]?.balance_after === 9, "unlock_spend row balance_after matches user.credits");

  /* ---------- 9. Transaction history ordering + admin adjustment ---------- */
  // Admin sets credits; ledger should record a single admin_adjustment row.
  await request("POST", "/api/me/logout");
  // Ensure the seeded admin password is set.
  const adminUser = await storage.getUserByEmail(adminEmail);
  if (adminUser && !adminUser.password_hash) {
    await storage.setUserPassword(adminUser.id, hashPassword(adminPassword));
  }
  const adminSignin = await request("POST", "/api/me/signin", {
    email: adminEmail,
    password: adminPassword,
  });
  assert(adminSignin.status === 200, "admin can sign in", adminSignin);
  // Target the locked user we just unlocked.
  const lockedUserRow = await storage.getUserByEmail(lockedEmail);
  assert(!!lockedUserRow, "admin can resolve the locked-user target");
  const adminSet = await request("POST", "/api/users/set-credits", {
    user_id: lockedUserRow!.id,
    credits: 50,
  });
  assert(
    adminSet.status === 200 && adminSet.json?.credits === 50,
    "admin set-credits succeeds with new balance",
    adminSet.json,
  );
  // Switch back to the locked user via session and check ledger.
  await request("POST", "/api/me/logout");
  await request("POST", "/api/me/signin", {
    email: lockedEmail,
    password: lockedPassword,
  });
  const fullTxs = await request("GET", "/api/credits/transactions");
  const allTxs = fullTxs.json?.transactions ?? [];
  assert(allTxs.length >= 3, "ledger has at least 3 rows after admin adjustment", allTxs.length);
  // Most recent first.
  assert(allTxs[0]?.reason === "admin_adjustment", "most recent row is the admin_adjustment");
  assert(
    allTxs[0]?.amount_delta === 50 - 9,
    "admin_adjustment delta matches new - previous balance",
    { delta: allTxs[0]?.amount_delta, expected: 50 - 9 },
  );
  assert(allTxs[0]?.balance_after === 50, "admin_adjustment row balance_after is 50");
  assert(
    typeof allTxs[0]?.reference === "string" && allTxs[0].reference.startsWith("admin:"),
    "admin_adjustment row records the adjusting admin",
    allTxs[0]?.reference,
  );

  /* ---------- 10. Unlimited entitlement bypasses ledger on unlock ---------- */
  // Ensure unlimited account has known password.
  const existingUnlimited = await storage.getUserByEmail(unlimitedEmail);
  if (!existingUnlimited) {
    await storage.createUser({
      full_name: "Alex Roqueta",
      email: unlimitedEmail,
      role: "user",
      credits: 0,
      created_date: new Date().toISOString(),
      password_hash: hashPassword(unlimitedPassword),
    });
  } else if (!existingUnlimited.password_hash) {
    await storage.setUserPassword(existingUnlimited.id, hashPassword(unlimitedPassword));
  }
  await request("POST", "/api/me/logout");
  const signinUnlimited = await request("POST", "/api/me/signin", {
    email: unlimitedEmail,
    password: unlimitedPassword,
  });
  assert(signinUnlimited.status === 200, "unlimited user signs in");
  // Generate an analysis with the unlimited user; it should NOT be locked,
  // so unlock is effectively a no-op. To exercise the unlock path, force-
  // lock an analysis via storage so we can test the entitlement bypass.
  const unlimitedAnalysis = await request("POST", "/api/analyses", {
    job_title: "Senior Program Manager",
    job_description:
      "Owns cross-functional programs across cloud, IoT, and platform teams.",
  });
  assert(
    unlimitedAnalysis.status === 200 && unlimitedAnalysis.json?.is_locked === false,
    "unlimited user gets an unlocked analysis by default",
  );
  // Force-lock to test the unlock path under entitlement.
  const forcedId = unlimitedAnalysis.json.id as number;
  // Flip the flag through the test-only storage helper. Works against
  // both SQLite and Postgres backends.
  await _setAnalysisLockedForTest(forcedId, true);
  const unlimitedUserRow =
    existingUnlimited ?? (await storage.getUserByEmail(unlimitedEmail))!;
  const txsBefore = (await storage.listCreditTransactions(unlimitedUserRow.id)).length;
  const unlimitedUnlock = await request("POST", `/api/analyses/${forcedId}/unlock`);
  assert(
    unlimitedUnlock.status === 200 && unlimitedUnlock.json?.is_locked === false,
    "unlimited user can unlock a forced-locked analysis",
  );
  const unlimitedUserAfter = (await storage.getUserByEmail(unlimitedEmail))!;
  const txsAfter = (await storage.listCreditTransactions(unlimitedUserAfter.id)).length;
  assert(
    txsAfter === txsBefore,
    "unlimited unlock does NOT append a ledger row (entitlement is independent of balance)",
    { before: txsBefore, after: txsAfter },
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
