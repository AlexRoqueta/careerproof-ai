/* End-to-end verification for the "first full report is free" flow.
 *
 * Run with:  npx tsx script/verify-free-first-report.ts
 *
 * Boots a real Express server against an isolated SQLite DB and asserts
 * the free-first growth requirement: every account can unlock its FIRST
 * full report for free (no credit card, no credits), and the entitlement
 * is consumed exactly once — server-side, ledger-backed, hard to abuse.
 *
 * Steps:
 *   1. Create a fresh account and drain to 0 credits.
 *   2. /api/me reports free_report_used = false.
 *   3. POST /api/analyses at 0 credits -> a locked record (id = A1).
 *   4. POST /api/analyses/A1/unlock at 0 credits -> succeeds for FREE:
 *      row unlocked in place, body readable, credits unchanged (still 0).
 *   5. The ledger has exactly one free_report_claim row for A1 with a
 *      zero amount_delta (it is an entitlement marker, not a debit).
 *   6. /api/me now reports free_report_used = true.
 *   7. Re-unlocking A1 is a no-op (already unlocked), no new ledger row.
 *   8. A SECOND analysis (A2) at 0 credits cannot be unlocked for free —
 *      the free entitlement is spent, so unlock returns 402
 *      insufficient_credits.
 *   9. Granting credits then unlocking A2 debits exactly one credit via
 *      a normal unlock_spend row (paid path still works for report 2+).
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
const tmpDir = mkdtempSync(join(tmpdir(), "free-first-verify-"));
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

const PORT = 4810;
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
const email = `verify_free_first_${stamp}@example.com`;
const PASSWORD = "VerifyFree1!";

try {
  /* 1. Sign up + drain to 0 credits ------------------------------------- */
  const signup = await request("POST", "/api/me/signup", {
    full_name: "Verify Free First",
    email,
    password: PASSWORD,
    confirm_password: PASSWORD,
  });
  assert(signup.status === 200, "signup returns 200", signup);
  await storage.setUserCredits(signup.json.id, 0);

  /* 2. /api/me reports the free report has NOT been used ---------------- */
  const me0 = await request("GET", "/api/me");
  assert(me0.json?.credits === 0, "user starts at 0 credits");
  assert(
    me0.json?.free_report_used === false,
    "free_report_used is false before any unlock",
    me0.json,
  );

  /* 3. First analysis at 0 credits -> locked record --------------------- */
  const a1 = await request("POST", "/api/analyses", {
    job_title: "Field Botanist",
    job_description:
      "Surveys plant populations in the field, records observations, and writes up findings for conservation planning.",
  });
  assert(a1.status === 200, "POST /api/analyses (A1) succeeds at 0 credits", a1);
  assert(a1.json?.is_locked === true, "A1 saved as locked", a1.json);
  const a1Id = a1.json?.id as number;

  /* 4. Unlock A1 for FREE — no credits, no payment ---------------------- */
  const unlock1 = await request("POST", `/api/analyses/${a1Id}/unlock`);
  assert(unlock1.status === 200, "first unlock succeeds for free at 0 credits", unlock1);
  assert(unlock1.json?.is_locked === false, "A1 is now unlocked");
  assert(unlock1.json?.id === a1Id, "A1 unlocked in place (same id)");
  assert(
    bodyLooksReadable(String(unlock1.json?.result_text ?? "")),
    "the free-unlocked A1 body is fully readable",
  );
  const meAfter1 = await request("GET", "/api/me");
  assert(
    meAfter1.json?.credits === 0,
    "free unlock does NOT consume any credits (still 0)",
    { credits: meAfter1.json?.credits },
  );

  /* 5. Ledger has exactly one zero-delta free_report_claim row for A1 --- */
  const tx1 = await request("GET", "/api/credits/transactions");
  const claimRows = (tx1.json?.transactions ?? []).filter(
    (t: any) => t.reason === "free_report_claim" && t.reference === `analysis:${a1Id}`,
  );
  assert(
    claimRows.length === 1,
    "ledger contains exactly one free_report_claim row for A1",
    { rows: claimRows },
  );
  assert(
    claimRows[0]?.amount_delta === 0,
    "the free_report_claim row is a zero-delta entitlement marker (no debit)",
    claimRows[0],
  );

  /* 6. /api/me now reports the free report as used ---------------------- */
  assert(
    meAfter1.json?.free_report_used === true,
    "free_report_used flips to true after the free unlock",
    meAfter1.json,
  );

  /* 7. Re-unlocking A1 is a no-op (no second claim row) ----------------- */
  const unlock1Retry = await request("POST", `/api/analyses/${a1Id}/unlock`);
  assert(unlock1Retry.status === 200, "re-unlock of A1 succeeds (no-op)", unlock1Retry);
  const tx1b = await request("GET", "/api/credits/transactions");
  const claimRowsB = (tx1b.json?.transactions ?? []).filter(
    (t: any) => t.reason === "free_report_claim" && t.reference === `analysis:${a1Id}`,
  );
  assert(
    claimRowsB.length === 1,
    "re-unlock does NOT append a second free_report_claim row",
    { rows: claimRowsB },
  );

  /* 8. Second analysis cannot be unlocked for free ---------------------- */
  const a2 = await request("POST", "/api/analyses", {
    job_title: "Marine Surveyor",
    job_description:
      "Inspects vessels and offshore structures, assesses condition, and reports on seaworthiness and compliance.",
  });
  assert(a2.status === 200, "POST /api/analyses (A2) succeeds at 0 credits", a2);
  assert(a2.json?.is_locked === true, "A2 saved as locked", a2.json);
  const a2Id = a2.json?.id as number;

  const unlock2Free = await request("POST", `/api/analyses/${a2Id}/unlock`);
  assert(
    unlock2Free.status === 402 &&
      String(unlock2Free.json?.reason ?? "") === "insufficient_credits",
    "second report cannot be unlocked for free (entitlement spent) -> 402",
    unlock2Free.json,
  );

  /* 9. Paid path still works for report 2+ ------------------------------ */
  const redeem = await request("POST", "/api/credits/redeem-code", { code: "10FREE" });
  assert(redeem.status === 200, "promo grants credits for the paid path", redeem.json);
  const meBeforePaid = await request("GET", "/api/me");
  const unlock2Paid = await request("POST", `/api/analyses/${a2Id}/unlock`);
  assert(unlock2Paid.status === 200, "A2 unlocks once credits are available", unlock2Paid);
  assert(unlock2Paid.json?.is_locked === false, "A2 is now unlocked");
  const meAfterPaid = await request("GET", "/api/me");
  assert(
    meAfterPaid.json?.credits === (meBeforePaid.json?.credits ?? 0) - 1,
    "second report debits exactly one credit (normal paid unlock)",
    { before: meBeforePaid.json?.credits, after: meAfterPaid.json?.credits },
  );
  const tx2 = await request("GET", "/api/credits/transactions");
  const spendRows = (tx2.json?.transactions ?? []).filter(
    (t: any) => t.reason === "unlock_spend" && t.reference === `analysis:${a2Id}`,
  );
  assert(
    spendRows.length === 1 && spendRows[0]?.amount_delta === -1,
    "ledger has exactly one unlock_spend (-1) row for A2",
    { rows: spendRows },
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
