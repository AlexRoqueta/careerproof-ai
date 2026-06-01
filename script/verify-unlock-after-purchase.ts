/* End-to-end verification for the "buy credits then unlock the
 * existing locked report" flow.
 *
 * Run with:  npx tsx script/verify-unlock-after-purchase.ts
 *
 * Boots a real Express server against an isolated SQLite DB and
 * asserts the end-to-end UX requirement: a user who runs an analysis
 * while at 0 credits, sees the locked report preview, buys credits,
 * and then unlocks THAT exact report — without rerunning the analysis
 * and without double-decrementing credits on refresh.
 *
 * Steps:
 *   1. Create a fresh account, drain to 0 credits.
 *   2. POST /api/analyses → returns a locked record with id=L.
 *   3. Attempting to unlock L returns 402 insufficient_credits.
 *   4. Simulate a successful purchase: redeem 10FREE promo (production
 *      uses the Stripe webhook; this script exercises the same
 *      grant-via-ledger path through the promo redemption endpoint so
 *      it does not depend on Stripe being wired).
 *   5. POST /api/analyses/L/unlock → analysis is now unlocked, body is
 *      readable, and credits decremented by exactly 1.
 *   6. Repeat POST /api/analyses/L/unlock → no-op (already unlocked,
 *      same row returned), credits NOT decremented (idempotent on
 *      refresh / accidental retry).
 *   7. Confirm the ledger has exactly one unlock_spend row for L.
 *   8. Verify the original analysis row was never re-created — same
 *      id, same job_title, same created_date.
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
const tmpDir = mkdtempSync(join(tmpdir(), "unlock-purchase-verify-"));
const originalCwd = process.cwd();
process.chdir(tmpDir);

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

const PORT = 4800;
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

function bodyLooksReadable(md: string): boolean {
  const lines = md.split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (/^#{1,3}\s/.test(line)) continue;
    if (/^---+$/.test(line)) continue;
    const words = line.match(/[A-Za-z]{3,}/g) ?? [];
    if (words.length >= 3) return true;
  }
  return false;
}

const stamp = Date.now();
const email = `verify_unlock_${stamp}@example.com`;
const PASSWORD = "VerifyUnlock1!";

try {
  /* 1. Sign up + drain welcome credit to 0 ------------------------------ */
  const signup = await request("POST", "/api/me/signup", {
    full_name: "Verify Unlock",
    email,
    password: PASSWORD,
    confirm_password: PASSWORD,
  });
  assert(signup.status === 200, "signup returns 200", signup);
  await storage.setUserCredits(signup.json.id, 0);
  // Consume the free-first entitlement on a throwaway analysis so the
  // locked-report flow below tests the PAID unlock path. Without this the
  // first unlock would be claimed for free and never hit the credit gate.
  const freebie = await request("POST", "/api/analyses", {
    job_title: "Lighthouse Keeper",
    job_description:
      "Maintains the lighthouse and its optics, logs weather, and assists passing vessels.",
  });
  await request("POST", `/api/analyses/${freebie.json.id}/unlock`);
  const me0 = await request("GET", "/api/me");
  assert(me0.json?.credits === 0, "user starts the locked-flow test at 0 credits");
  assert(
    me0.json?.free_report_used === true,
    "free-first entitlement is consumed before the paid-unlock test",
    me0.json,
  );

  /* 2. POST /api/analyses with 0 credits -> locked record --------------- */
  const analyze = await request("POST", "/api/analyses", {
    job_title: "Curator Of Digital Archives",
    job_description:
      "Maintains a digital archive of cultural artifacts, designs metadata schemas, and supports researcher access.",
  });
  assert(analyze.status === 200, "POST /api/analyses succeeds at 0 credits", analyze);
  assert(analyze.json?.is_locked === true, "the saved analysis is locked", analyze.json);
  const lockedId = analyze.json?.id as number;
  const originalCreatedDate = String(analyze.json?.created_date ?? "");
  const originalJobTitle = String(analyze.json?.job_title ?? "");
  assert(
    !bodyLooksReadable(String(analyze.json?.result_text ?? "")),
    "the locked POST response body is redacted",
  );

  /* 3. Trying to unlock with 0 credits returns 402 ---------------------- */
  const unlockNoCredits = await request("POST", `/api/analyses/${lockedId}/unlock`);
  assert(
    unlockNoCredits.status === 402 &&
      String(unlockNoCredits.json?.reason ?? "") === "insufficient_credits",
    "unlock at 0 credits returns 402 insufficient_credits",
    unlockNoCredits.json,
  );

  /* 4. Simulate a successful purchase by redeeming 10FREE --------------- */
  /* In production this is a Stripe Checkout completion that flows
   * through the webhook + ledger. The promo redemption exercises the
   * same `storage.setUserCredits` + ledger-append path, so this script
   * does not depend on the Stripe SDK or test-mode credentials. */
  const before = await request("GET", "/api/me");
  const redeem = await request("POST", "/api/credits/redeem-code", { code: "10FREE" });
  assert(
    redeem.status === 200 && redeem.json?.credits_added === 10,
    "10FREE promo grants 10 credits",
    redeem.json,
  );
  const afterRedeem = await request("GET", "/api/me");
  assert(
    afterRedeem.json?.credits === (before.json?.credits ?? 0) + 10,
    "credits balance reflects the grant",
  );

  /* 5. Unlock the EXISTING locked report -------------------------------- */
  /* This is the core requirement: the same analysis id from step 2 is
   * unlocked in place. We never re-create the analysis row, never
   * re-run the AI, and the readable body becomes available. */
  const unlocked = await request("POST", `/api/analyses/${lockedId}/unlock`);
  assert(unlocked.status === 200, "unlock after purchase succeeds", unlocked);
  assert(unlocked.json?.is_locked === false, "the analysis row is now unlocked");
  assert(unlocked.json?.id === lockedId, "the unlocked row preserves the original id");
  assert(
    unlocked.json?.job_title === originalJobTitle,
    "the unlocked row preserves the original job_title",
  );
  assert(
    String(unlocked.json?.created_date ?? "") === originalCreatedDate,
    "the unlocked row preserves the original created_date (analysis was NOT rerun)",
  );
  assert(
    bodyLooksReadable(String(unlocked.json?.result_text ?? "")),
    "the unlocked body is fully readable",
  );
  const afterUnlock = await request("GET", "/api/me");
  assert(
    afterUnlock.json?.credits === (afterRedeem.json?.credits ?? 0) - 1,
    "credits decrement by exactly one on unlock",
    { before: afterRedeem.json?.credits, after: afterUnlock.json?.credits },
  );

  /* 6. Refresh / accidental retry must not double-decrement ------------- */
  /* The route handler short-circuits on `is_locked === false` and
   * returns the row without touching the ledger. Hitting unlock again
   * with the same id is therefore safe across page refresh, race
   * conditions, or the user clicking the button twice. */
  const unlockRetry = await request("POST", `/api/analyses/${lockedId}/unlock`);
  assert(unlockRetry.status === 200, "second unlock call succeeds (no-op)", unlockRetry);
  assert(unlockRetry.json?.is_locked === false, "second unlock keeps the row unlocked");
  const afterRetry = await request("GET", "/api/me");
  assert(
    afterRetry.json?.credits === afterUnlock.json?.credits,
    "refresh / retry does NOT double-decrement credits",
    { after_unlock: afterUnlock.json?.credits, after_retry: afterRetry.json?.credits },
  );

  /* 7. Ledger contains exactly one unlock_spend for this analysis ------- */
  const txList = await request("GET", "/api/credits/transactions");
  const unlockRows = (txList.json?.transactions ?? []).filter(
    (t: any) => t.reason === "unlock_spend" && t.reference === `analysis:${lockedId}`,
  );
  assert(
    unlockRows.length === 1,
    "ledger contains exactly one unlock_spend row for the analysis",
    { rows: unlockRows },
  );
  assert(
    unlockRows[0]?.amount_delta === -1,
    "the unlock_spend ledger row debits exactly 1 credit",
    unlockRows[0],
  );

  /* 8. Confirm the original analysis row is still present + unlocked ---- */
  const finalAnalysis = await request("GET", `/api/analyses/${lockedId}`);
  assert(
    finalAnalysis.status === 200 &&
      finalAnalysis.json?.id === lockedId &&
      finalAnalysis.json?.is_locked === false,
    "final GET confirms the same locked report is now unlocked in place",
    finalAnalysis.json,
  );
  const all = await request("GET", "/api/analyses");
  const matching = Array.isArray(all.json)
    ? all.json.filter((a: any) => a.job_title === originalJobTitle)
    : [];
  assert(
    matching.length === 1,
    "analysis was NOT duplicated — exactly one row exists for the original job_title",
    { count: matching.length },
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
