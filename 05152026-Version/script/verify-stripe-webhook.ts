/* Unit-level verification for the Stripe webhook path.
 *
 * Run with:  npx tsx script/verify-stripe-webhook.ts
 *
 * This test exercises the signature verification + fulfillment logic
 * WITHOUT touching the live Stripe API. We:
 *
 *   1. Build a `StripePaymentProvider` against a synthetic
 *      STRIPE_WEBHOOK_SECRET (whsec_test_*).
 *   2. Construct a `checkout.session.completed` event payload that
 *      mirrors what Stripe sends \u2014 paid status, metadata with our
 *      user_id / package_id / credits / amount_cents.
 *   3. Compute the Stripe-Signature header ourselves using HMAC-SHA256
 *      over `{timestamp}.{body}` per Stripe's signature spec.
 *   4. Boot a tiny Express app with the same JSON middleware as
 *      production (raw body captured via `verify`) and POST the
 *      webhook body with the computed signature header.
 *   5. Assert that:
 *      - Valid signature on a paid session \u2192 200 + fulfilled=true,
 *        the user's credits increase by exactly the package credits,
 *        and the ledger contains a row with reference
 *        `stripe:checkout_session:<id>`.
 *      - Replaying the same event \u2192 200 + duplicate=true, no extra
 *        credits, no second ledger row.
 *      - Tampered body (same signature) \u2192 400.
 *      - Unrelated event type (`payment_intent.succeeded`) \u2192 200 with
 *        fulfilled=false, no ledger row.
 *      - Missing Stripe-Signature header \u2192 400.
 *      - Wrong webhook secret used by sender \u2192 400.
 *      - payment_status='unpaid' \u2192 200 + fulfilled=false (ack only).
 *
 * The Stripe Node SDK is loaded; no `stripe.checkout.sessions.create`
 * calls are made, so no network is required. Exit code is non-zero on
 * any failure so CI can gate the build.
 */
import { createHmac, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const projectRoot = dirname(dirname(__filename));
const tmpDir = mkdtempSync(join(tmpdir(), "ousted-verify-stripe-"));
const originalCwd = process.cwd();
process.chdir(tmpDir);

/* Set env BEFORE importing payments.ts so the live provider switch
 * picks Stripe. The keys are synthetic \u2014 we never call the live
 * Stripe API, only the local crypto routines. */
process.env.PAYMENT_PROVIDER = "stripe";
process.env.STRIPE_SECRET_KEY = "sk_test_verifyStripeWebhook_fake_key";
process.env.STRIPE_WEBHOOK_SECRET = `whsec_test_${randomBytes(16).toString("hex")}`;

const { default: express } = await import("express");
const { createServer } = await import("node:http");
const { registerRoutes } = await import("../server/routes");
const storageMod = await import("../server/storage");
await storageMod.initStorage();
const { storage } = storageMod;
const { hashPassword } = await import("../server/password");
const { paymentProvider } = await import("../server/payments");

const app = express();
/* Same middleware as production: capture raw body for webhook
 * signature verification. */
app.use(
  express.json({
    limit: "20mb",
    verify: (req: any, _res, buf) => {
      req.rawBody = buf;
    },
  }),
);
const httpServer = createServer(app);
await registerRoutes(httpServer, app);

const PORT = 4812;
await new Promise<void>((resolve) => httpServer.listen(PORT, resolve));
const base = `http://127.0.0.1:${PORT}`;

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

/* Compute the Stripe-Signature header per Stripe's spec:
 *   sig_payload = `{timestamp}.{body}`
 *   v1 = HMAC-SHA256(secret, sig_payload).hex
 *   header = `t={timestamp},v1={v1}`
 * Stripe uses the raw secret value (including the `whsec_` prefix)
 * as the HMAC key — match that behavior exactly. */
function signWithSecret(rawBody: string, secret: string, ts?: number): string {
  const timestamp = ts ?? Math.floor(Date.now() / 1000);
  const signedPayload = `${timestamp}.${rawBody}`;
  const v1 = createHmac("sha256", secret).update(signedPayload).digest("hex");
  return `t=${timestamp},v1=${v1}`;
}

async function postWebhook(rawBody: string, signature: string | null) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (signature !== null) headers["Stripe-Signature"] = signature;
  const res = await fetch(`${base}/api/payments/webhook`, {
    method: "POST",
    headers,
    body: rawBody,
  });
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, json };
}

const stamp = Date.now();
const buyerEmail = `verify_stripe_${stamp}@example.com`;
const buyerPassword = "StripeVerify1!";

try {
  /* Make sure the active provider is the real Stripe provider (not the
   * fallback preview path). The constructor pulled our synthetic keys. */
  assert(
    paymentProvider.name === "stripe",
    "PAYMENT_PROVIDER=stripe selects StripePaymentProvider",
    paymentProvider.name,
  );
  assert(
    typeof paymentProvider.parseWebhookEvent === "function",
    "Stripe provider exposes parseWebhookEvent",
  );

  /* Create a buyer user directly through storage (no signin needed \u2014
   * webhook delivery does not carry a session). */
  const buyer = await storage.createUser({
    full_name: "Stripe Verify Buyer",
    email: buyerEmail,
    role: "user",
    credits: 0,
    created_date: new Date().toISOString(),
    password_hash: hashPassword(buyerPassword),
  });

  const SESSION_ID = `cs_test_${randomBytes(12).toString("hex")}`;
  const EVENT_ID = `evt_test_${randomBytes(12).toString("hex")}`;
  const pkgId = "standard_3";
  const pkgCredits = 3;
  const pkgPriceCents = 700;

  function buildEvent(overrides: Partial<{
    event_id: string;
    event_type: string;
    session_id: string;
    payment_status: string;
    user_id: number;
    package_id: string;
    credits: number;
    amount_cents: number;
  }> = {}) {
    return {
      id: overrides.event_id ?? EVENT_ID,
      object: "event",
      api_version: "2024-06-20",
      created: Math.floor(Date.now() / 1000),
      type: overrides.event_type ?? "checkout.session.completed",
      data: {
        object: {
          id: overrides.session_id ?? SESSION_ID,
          object: "checkout.session",
          payment_status: overrides.payment_status ?? "paid",
          amount_total: overrides.amount_cents ?? pkgPriceCents,
          currency: "usd",
          customer_email: buyerEmail,
          customer_details: { email: buyerEmail },
          metadata: {
            user_id: String(overrides.user_id ?? buyer.id),
            package_id: overrides.package_id ?? pkgId,
            credits: String(overrides.credits ?? pkgCredits),
            amount_cents: String(overrides.amount_cents ?? pkgPriceCents),
          },
        },
      },
    };
  }

  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET!;

  /* ---------- 1. Missing signature header \u2192 400 ---------- */
  const noSig = await postWebhook(JSON.stringify(buildEvent()), null);
  assert(noSig.status === 400, "missing Stripe-Signature header returns 400", noSig);

  /* ---------- 2. Wrong secret used by sender \u2192 400 ---------- */
  const wrongSecret = `whsec_wrong_${randomBytes(8).toString("hex")}`;
  const wrongBody = JSON.stringify(buildEvent());
  const wrongSig = signWithSecret(wrongBody, wrongSecret);
  const wrongRes = await postWebhook(wrongBody, wrongSig);
  assert(wrongRes.status === 400, "signature computed with wrong secret returns 400", wrongRes);

  /* ---------- 3. Tampered body, valid signature against ORIGINAL body \u2192 400 ---------- */
  const origBody = JSON.stringify(buildEvent());
  const origSig = signWithSecret(origBody, webhookSecret);
  const tamperedBody = origBody.replace(/"credits":"3"/, '"credits":"99"');
  const tamperedRes = await postWebhook(tamperedBody, origSig);
  assert(tamperedRes.status === 400, "tampered body fails signature verification", tamperedRes);
  const buyerAfterTamper = await storage.getUser(buyer.id);
  assert(buyerAfterTamper?.credits === 0, "tampered webhook did not grant credits");

  /* ---------- 4. Valid signature on paid session \u2192 200 + fulfilled ---------- */
  const validBody = JSON.stringify(buildEvent());
  const validSig = signWithSecret(validBody, webhookSecret);
  const validRes = await postWebhook(validBody, validSig);
  assert(validRes.status === 200, "valid signature returns 200", validRes);
  assert(validRes.json?.fulfilled === true, "valid paid webhook fulfills the purchase", validRes.json);
  assert(validRes.json?.credits === pkgCredits, "webhook reports the granted credit count", validRes.json);

  const buyerAfter = await storage.getUser(buyer.id);
  assert(
    buyerAfter?.credits === pkgCredits,
    `buyer credits increased by ${pkgCredits} (got ${buyerAfter?.credits})`,
    buyerAfter,
  );
  const txs = await storage.listCreditTransactions(buyer.id);
  const purchaseRow = txs.find((t) => t.reason === "purchase");
  assert(purchaseRow, "ledger contains a purchase row", txs);
  assert(
    purchaseRow?.reference === `stripe:checkout_session:${SESSION_ID}`,
    "purchase row reference is stripe:checkout_session:<id>",
    purchaseRow?.reference,
  );
  assert(purchaseRow?.amount_delta === pkgCredits, "purchase row delta matches package credits");
  assert(purchaseRow?.provider === "stripe", "purchase row records provider=stripe");

  /* ---------- 5. Replay same event \u2192 200 + duplicate, no extra credits ---------- */
  const replayRes = await postWebhook(validBody, signWithSecret(validBody, webhookSecret));
  assert(replayRes.status === 200, "replay returns 200", replayRes);
  assert(replayRes.json?.duplicate === true, "replay is flagged duplicate", replayRes.json);
  assert(replayRes.json?.fulfilled === false, "replay did not re-fulfill");
  const buyerAfterReplay = await storage.getUser(buyer.id);
  assert(
    buyerAfterReplay?.credits === pkgCredits,
    `replay did NOT double-grant (still ${pkgCredits})`,
    buyerAfterReplay,
  );
  const txsAfterReplay = await storage.listCreditTransactions(buyer.id);
  const purchaseRows = txsAfterReplay.filter((t) => t.reason === "purchase");
  assert(purchaseRows.length === 1, "exactly one purchase row after replay", purchaseRows.length);

  /* ---------- 6. Unrelated event type \u2192 200 + fulfilled=false ---------- */
  const otherEventBody = JSON.stringify(
    buildEvent({ event_id: `evt_test_${randomBytes(8).toString("hex")}`, event_type: "payment_intent.succeeded" }),
  );
  const otherSig = signWithSecret(otherEventBody, webhookSecret);
  const otherRes = await postWebhook(otherEventBody, otherSig);
  assert(otherRes.status === 200, "unrelated event type returns 200", otherRes);
  assert(otherRes.json?.fulfilled === false, "unrelated event does not fulfill");

  /* ---------- 7. session.completed but payment_status='unpaid' \u2192 200 + fulfilled=false ---------- */
  const unpaidBody = JSON.stringify(
    buildEvent({
      event_id: `evt_test_${randomBytes(8).toString("hex")}`,
      session_id: `cs_test_${randomBytes(8).toString("hex")}`,
      payment_status: "unpaid",
    }),
  );
  const unpaidSig = signWithSecret(unpaidBody, webhookSecret);
  const unpaidRes = await postWebhook(unpaidBody, unpaidSig);
  assert(unpaidRes.status === 200, "unpaid completed-session returns 200", unpaidRes);
  assert(unpaidRes.json?.fulfilled === false, "unpaid session is NOT fulfilled");

  /* ---------- 8. Unknown user_id in metadata \u2192 200 + fulfilled=false ---------- */
  const orphanBody = JSON.stringify(
    buildEvent({
      event_id: `evt_test_${randomBytes(8).toString("hex")}`,
      session_id: `cs_test_${randomBytes(8).toString("hex")}`,
      user_id: 999999,
    }),
  );
  const orphanSig = signWithSecret(orphanBody, webhookSecret);
  const orphanRes = await postWebhook(orphanBody, orphanSig);
  assert(orphanRes.status === 200, "unknown user_id returns 200 (ack)", orphanRes);
  assert(orphanRes.json?.fulfilled === false, "unknown user_id is not fulfilled");

  /* ---------- 9. Credit count mismatch with catalog \u2192 not fulfilled ---------- */
  const mismatchBody = JSON.stringify(
    buildEvent({
      event_id: `evt_test_${randomBytes(8).toString("hex")}`,
      session_id: `cs_test_${randomBytes(8).toString("hex")}`,
      credits: 999,
    }),
  );
  const mismatchSig = signWithSecret(mismatchBody, webhookSecret);
  const mismatchRes = await postWebhook(mismatchBody, mismatchSig);
  assert(mismatchRes.status === 200, "credit-mismatch event returns 200 (ack only)", mismatchRes);
  assert(
    mismatchRes.json?.fulfilled === false,
    "credit-mismatch event is rejected without fulfillment",
    mismatchRes.json,
  );
  const buyerFinal = await storage.getUser(buyer.id);
  assert(
    buyerFinal?.credits === pkgCredits,
    "credit-mismatch event did not change the buyer balance",
    buyerFinal,
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
console.log(`\nAll Stripe webhook verification cases passed.`);
