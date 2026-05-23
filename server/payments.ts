/* =====================================================================
 * Provider-agnostic payments abstraction.
 *
 * The CareerProof AI app sells small digital credit packs. The chosen
 * production payment provider is intentionally pluggable: the route
 * handlers only ever talk to PaymentProvider, never directly to a
 * specific SDK. To swap providers, implement the interface in a new
 * file and replace the `paymentProvider` export below.
 *
 * Production recommendation (handoff):
 *   - Default: Stripe Checkout. Hosted-checkout URL + `checkout.session
 *     .completed` webhook. Best fit for a US-based merchant selling
 *     simple digital credit packs at a few dollars per transaction.
 *   - If the operator needs merchant-of-record VAT/GST handling for a
 *     global audience: Lemon Squeezy (or Paddle). Same interface; the
 *     provider takes responsibility for tax compliance.
 *
 * The preview provider below NEVER takes real money. It returns a
 * loopback URL that re-enters the app with `status=preview-success`
 * and a signed package id. The completion handler in routes.ts only
 * grants credits via the ledger \u2014 the preview provider does not write
 * to the credit_transactions table itself.
 * ===================================================================== */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import Stripe from "stripe";
import { CREDIT_PACKAGES, findCreditPackage, type CreditPackage } from "@shared/entitlements";
import {
  LAUNCH_PROMO_TARGET_PACKAGE_ID,
  promoReferenceSuffix,
  type LaunchPromoState,
} from "@shared/launchPromo";
import { getLaunchPromoState } from "./launchPromo";

/* Resolve the effective unit price + metadata for a checkout. When the
 * launch promo is active AND the requested package is the single-credit
 * starter, the price is replaced with the promo price and the returned
 * `promo_applied` flag tells the route layer to tag the ledger
 * reference so subsequent counts and analytics can attribute the sale
 * to the promo. */
export interface ResolvedPricing {
  unit_amount: number;
  promo_applied: boolean;
  promo_state: LaunchPromoState;
}

export async function resolvePricingForPackage(pkg: CreditPackage): Promise<ResolvedPricing> {
  const promo = await getLaunchPromoState();
  const isPromoTarget = pkg.id === LAUNCH_PROMO_TARGET_PACKAGE_ID;
  if (promo.active && isPromoTarget) {
    return {
      unit_amount: promo.promo_price_cents,
      promo_applied: true,
      promo_state: promo,
    };
  }
  return {
    unit_amount: pkg.price_cents,
    promo_applied: false,
    promo_state: promo,
  };
}

/* Common types -------------------------------------------------------- */
export interface CreateCheckoutInput {
  user_id: number;
  user_email: string;
  package_id: string;
  /** Absolute URL the provider should send the buyer to after success. */
  success_url: string;
  /** Absolute URL the provider should send the buyer to after cancel. */
  cancel_url: string;
}

export interface CreateCheckoutResult {
  /** URL the client should redirect / open to complete the purchase. */
  checkout_url: string;
  /** Provider session id (for our records); preview-only when in preview mode. */
  session_id: string;
  /** Effective price (cents) the buyer is being charged for this session. */
  amount_cents: number;
  /** True when the launch promo discount was applied to this session. */
  promo_applied: boolean;
  /** Promo identifier ("launch50") when promo_applied; null otherwise. */
  promo_name: string | null;
  /** Identifier of the resolved package (echoed back). */
  package_id: string;
  /** Provider name reported on the ledger row when the purchase completes. */
  provider: string;
  /** True when the provider is the preview/test stub (no real payment). */
  preview: boolean;
}

export interface VerifySessionInput {
  session_id: string;
  /** Provider-specific verifier payload (e.g. signed token, signature). */
  token?: string;
}

export interface VerifySessionResult {
  ok: boolean;
  /** Resolved package, if the session was a successful purchase. */
  package?: CreditPackage;
  /** Provider name to record on the ledger row. */
  provider: string;
  error?: string;
}

/* =====================================================================
 * Webhook event parsing
 *
 * Live providers (Stripe) authenticate webhook deliveries via an HMAC
 * signature over the raw request body. The provider exposes a
 * `parseWebhookEvent(rawBody, signature)` hook that returns enough
 * structured data for the route handler to fulfill credits. The
 * preview provider has no webhook (purchases are completed inline) so
 * it intentionally does not implement this method.
 * ===================================================================== */
export interface WebhookFulfillment {
  /** Provider session id (Stripe Checkout Session id, etc.). */
  session_id: string;
  /** Resolved package this purchase grants. */
  package: CreditPackage;
  /** User id encoded in the metadata when the session was created. */
  user_id: number;
  /** Credit amount the webhook reports the buyer paid for. */
  credits: number;
  /** Total charged in cents (informational). */
  amount_cents: number;
  /** Buyer email reported by the provider, if available. */
  customer_email?: string;
  /** Launch promo identifier when the session metadata flagged it; null otherwise. */
  promo_name?: string | null;
}

export interface WebhookParseResult {
  /** Event id (provider-assigned). Used for ack-only logging. */
  event_id: string;
  /** Event type (e.g. checkout.session.completed). */
  event_type: string;
  /**
   * Fulfillment payload when this event grants credits. Null when the
   * event is something we ack but don't act on (other event types,
   * session.completed where payment_status != 'paid', etc.).
   */
  fulfillment: WebhookFulfillment | null;
}

export interface PaymentProvider {
  readonly name: string;
  /** True when this provider does not process real payments. */
  readonly isPreview: boolean;
  /** Human-readable label rendered in the UI banner. */
  readonly displayName: string;
  /** Create a checkout session and return its URL. */
  createCheckout(input: CreateCheckoutInput): Promise<CreateCheckoutResult>;
  /** Verify a completed session before granting credits. Idempotent. */
  verifySession(input: VerifySessionInput): Promise<VerifySessionResult>;
  /** List the credit packages this provider serves. */
  listPackages(): CreditPackage[];
  /**
   * Verify + parse a webhook delivery. Implemented by live providers
   * only. Throws when the signature does not verify; returns
   * fulfillment=null for ignored event types.
   */
  parseWebhookEvent?(rawBody: Buffer | string, signature: string): WebhookParseResult;
}

/* =====================================================================
 * Preview provider \u2014 NO REAL PAYMENT
 *
 * The preview provider:
 *   - Accepts a package id, signs it with an HMAC, and returns a
 *     loopback `success_url?status=preview-success&...&token=<sig>`.
 *   - verifySession recomputes the HMAC over the same fields and
 *     timing-safe-compares it. Tampering with the credits field, the
 *     package id, or the session id voids the token.
 *   - Never writes to the ledger. The route handler is responsible for
 *     appending exactly one `purchase` row when verifySession returns
 *     `ok: true`, and is also responsible for idempotency (we record
 *     the `session_id` in the ledger reference so duplicate completion
 *     calls become no-ops by lookup).
 *
 * The signing secret is process-scoped so server restarts invalidate
 * outstanding preview tokens (acceptable for a preview build). A real
 * deployment uses the chosen provider's webhook signature instead.
 * ===================================================================== */
const PREVIEW_SIGNING_SECRET = randomBytes(32);

function signPreviewToken(parts: { session_id: string; package_id: string }): string {
  const h = createHmac("sha256", PREVIEW_SIGNING_SECRET);
  h.update(`${parts.session_id}|${parts.package_id}`);
  return h.digest("hex");
}

class PreviewPaymentProvider implements PaymentProvider {
  readonly name = "preview";
  readonly isPreview = true;
  readonly displayName = "Preview checkout (no real payment)";

  listPackages(): CreditPackage[] {
    return CREDIT_PACKAGES;
  }

  async createCheckout(input: CreateCheckoutInput): Promise<CreateCheckoutResult> {
    const pkg = findCreditPackage(input.package_id);
    if (!pkg) throw new Error(`Unknown package: ${input.package_id}`);
    const pricing = await resolvePricingForPackage(pkg);
    const session_id = `preview_${Date.now().toString(36)}_${randomBytes(6).toString("hex")}`;
    const token = signPreviewToken({ session_id, package_id: pkg.id });
    /* Build a URL that loops back through the app's success_url with
     * the fields the verify endpoint needs. The frontend success page
     * POSTs to /api/payments/complete-checkout with these fields and
     * the route handler calls verifySession before granting credits.
     * The promo flag rides along so the completion path can tag the
     * ledger reference for downstream counting. */
    const url = new URL(input.success_url);
    url.searchParams.set("status", "preview-success");
    url.searchParams.set("session_id", session_id);
    url.searchParams.set("package_id", pkg.id);
    url.searchParams.set("token", token);
    if (pricing.promo_applied) {
      url.searchParams.set("promo", pricing.promo_state.name);
    }
    return {
      checkout_url: url.toString(),
      session_id,
      package_id: pkg.id,
      provider: this.name,
      preview: true,
      amount_cents: pricing.unit_amount,
      promo_applied: pricing.promo_applied,
      promo_name: pricing.promo_applied ? pricing.promo_state.name : null,
    };
  }

  async verifySession(input: VerifySessionInput): Promise<VerifySessionResult> {
    if (!input.token) {
      return { ok: false, provider: this.name, error: "Missing session token" };
    }
    if (!input.session_id || !input.session_id.startsWith("preview_")) {
      return { ok: false, provider: this.name, error: "Invalid session id" };
    }
    /* Recover the package id from the token. The session_id alone is
     * not enough \u2014 we re-derive every signed combination of the
     * publicly known packages and pick whichever matches the supplied
     * token. This avoids trusting the package_id field directly even
     * though the route handler also passes it; defense-in-depth. */
    for (const pkg of CREDIT_PACKAGES) {
      const expected = signPreviewToken({ session_id: input.session_id, package_id: pkg.id });
      const a = Buffer.from(expected, "hex");
      const b = Buffer.from(input.token, "hex");
      if (a.length === b.length && timingSafeEqual(a, b)) {
        return { ok: true, provider: this.name, package: pkg };
      }
    }
    return { ok: false, provider: this.name, error: "Invalid or expired session token" };
  }
}

/* =====================================================================
 * Stripe Checkout provider
 *
 * Hosted-checkout flow:
 *   1. createCheckout() calls Stripe to create a one-time Checkout
 *      Session with `mode='payment'`, an inline `price_data` matching
 *      the credit package, success_url/cancel_url built from
 *      APP_BASE_URL, customer_email, and metadata that round-trips the
 *      user/package/credits/amount through the webhook.
 *   2. The browser redirects to `session.url`. After paying, Stripe
 *      redirects the buyer back to `success_url` (or `cancel_url`).
 *   3. Authoritative fulfillment is via the `checkout.session.completed`
 *      webhook, NOT the success redirect. The webhook handler verifies
 *      the signature against STRIPE_WEBHOOK_SECRET, requires
 *      payment_status='paid', and grants credits via the ledger with
 *      the idempotency reference `stripe:checkout_session:<id>`.
 *   4. verifySession() exists for the existing /complete-checkout
 *      route but is intentionally NOT the grant path. It retrieves the
 *      session, checks payment_status, and reports the resolved
 *      package; route handlers must NOT use it to grant credits when
 *      provider=stripe (the webhook is authoritative).
 *
 * Required env vars (validated in server/config.ts):
 *   - STRIPE_SECRET_KEY      live or test secret (sk_test_... / sk_live_...)
 *   - STRIPE_WEBHOOK_SECRET  whsec_... from Stripe Dashboard endpoint
 * Optional:
 *   - STRIPE_API_VERSION     pin a specific API version (default null \u2192
 *                            SDK default for the installed Stripe lib)
 * ===================================================================== */
class StripePaymentProvider implements PaymentProvider {
  readonly name = "stripe";
  readonly isPreview = false;
  readonly displayName = "Stripe Checkout";
  private readonly stripe: Stripe;
  private readonly webhookSecret: string;

  constructor() {
    const apiKey = (process.env.STRIPE_SECRET_KEY ?? "").trim();
    if (!apiKey) {
      throw new Error(
        "STRIPE_SECRET_KEY is required when PAYMENT_PROVIDER=stripe. Set it in your environment.",
      );
    }
    const apiVersion = (process.env.STRIPE_API_VERSION ?? "").trim();
    this.stripe = new Stripe(apiKey, apiVersion ? ({ apiVersion } as any) : ({} as any));
    this.webhookSecret = (process.env.STRIPE_WEBHOOK_SECRET ?? "").trim();
    // Don't throw if webhook secret is missing at construction time \u2014
    // it lets `/api/payments/packages` and createCheckout still work
    // while the operator is wiring the Dashboard webhook. The webhook
    // route surfaces a clear 500 if invoked without it.
  }

  listPackages(): CreditPackage[] {
    return CREDIT_PACKAGES;
  }

  async createCheckout(input: CreateCheckoutInput): Promise<CreateCheckoutResult> {
    const pkg = findCreditPackage(input.package_id);
    if (!pkg) throw new Error(`Unknown package: ${input.package_id}`);

    /* Launch promo: the regular catalog price stays as the displayed
     * tile price, but if the promo is active and the buyer picked the
     * single-credit ("starter_1") package we charge the discounted
     * `promo_price_cents` instead. The promo tag is persisted in the
     * session metadata so the webhook handler can append the
     * `:promo=<name>` suffix to the ledger reference for later counting
     * and analytics attribution. */
    const pricing = await resolvePricingForPackage(pkg);
    const unitAmount = pricing.unit_amount;
    const promoName = pricing.promo_applied ? pricing.promo_state.name : null;

    /* Inline price_data: the credit catalog (shared/entitlements.ts) is
     * the source of truth for both the in-app price tile and what the
     * buyer is actually charged. Using inline price_data avoids the
     * operator having to mirror the catalog as Stripe Product/Price
     * records and keeps the ZIP self-contained \u2014 a fresh Stripe
     * account can wire this build without touching the Dashboard
     * (other than the webhook endpoint). */
    const sessionMetadata: Record<string, string> = {
      user_id: String(input.user_id),
      package_id: pkg.id,
      credits: String(pkg.credits),
      amount_cents: String(unitAmount),
    };
    if (promoName) {
      sessionMetadata.promo = promoName;
    }
    const productName = pricing.promo_applied
      ? `${pkg.name} \u2014 ${pkg.credits} credit (launch ${pricing.promo_state.name})`
      : `${pkg.name} \u2014 ${pkg.credits} credit${pkg.credits === 1 ? "" : "s"}`;
    const session = await this.stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: pkg.currency.toLowerCase(),
            unit_amount: unitAmount,
            product_data: {
              name: productName,
              description: pkg.description,
              metadata: {
                package_id: pkg.id,
                credits: String(pkg.credits),
                ...(promoName ? { promo: promoName } : {}),
              },
            },
          },
        },
      ],
      success_url: appendStripeSessionParam(input.success_url),
      cancel_url: appendStripeStatusParam(input.cancel_url, "cancel"),
      customer_email: input.user_email || undefined,
      /* Metadata persists on the Checkout Session and the resulting
       * PaymentIntent. The webhook handler reads these fields back to
       * resolve the user + package without having to trust anything
       * coming from the buyer's browser. */
      metadata: sessionMetadata,
      /* Tighten the session lifetime so abandoned sessions don't sit
       * pending forever. 30 minutes is plenty for a checkout flow but
       * limits the ambiguity window if a buyer closes the tab and
       * comes back tomorrow. */
      expires_at: Math.floor(Date.now() / 1000) + 30 * 60,
    });

    if (!session.url) {
      throw new Error("Stripe did not return a Checkout URL");
    }
    return {
      checkout_url: session.url,
      session_id: session.id,
      package_id: pkg.id,
      provider: this.name,
      preview: false,
      amount_cents: unitAmount,
      promo_applied: pricing.promo_applied,
      promo_name: promoName,
    };
  }

  async verifySession(input: VerifySessionInput): Promise<VerifySessionResult> {
    /* For Stripe, /complete-checkout exists as a UX nicety so the buyer
     * sees an "in flight" state when they land back on /#/credits.
     * The webhook is the authoritative grant path \u2014 verifySession
     * reports whether the session has paid, but it must NOT be used to
     * append the ledger row directly when provider=stripe. The route
     * handler enforces this. */
    if (!input.session_id) {
      return { ok: false, provider: this.name, error: "Missing session id" };
    }
    try {
      const session = await this.stripe.checkout.sessions.retrieve(input.session_id);
      if (session.payment_status !== "paid") {
        return {
          ok: false,
          provider: this.name,
          error: `Session not paid (payment_status=${session.payment_status ?? "unknown"})`,
        };
      }
      const packageId = String(session.metadata?.package_id ?? "");
      const pkg = findCreditPackage(packageId);
      if (!pkg) {
        return { ok: false, provider: this.name, error: "Session metadata is missing a known package id" };
      }
      return { ok: true, provider: this.name, package: pkg };
    } catch (err: any) {
      return { ok: false, provider: this.name, error: err?.message ?? "Stripe verifySession failed" };
    }
  }

  /* Webhook verification + parsing.
   *
   * Uses the Stripe SDK's `webhooks.constructEvent` helper to verify
   * the `Stripe-Signature` header against STRIPE_WEBHOOK_SECRET over
   * the raw request body. Per Stripe docs, the body MUST be the exact
   * bytes received \u2014 any JSON re-serialization breaks the signature.
   * The route layer ensures we have the raw buffer.
   *
   * Only `checkout.session.completed` triggers a fulfillment payload;
   * other event types return `fulfillment: null` so the route layer
   * can ack them without writing to the ledger.
   */
  parseWebhookEvent(rawBody: Buffer | string, signature: string): WebhookParseResult {
    if (!this.webhookSecret) {
      throw new Error(
        "STRIPE_WEBHOOK_SECRET is required to verify webhook deliveries. Set it in your environment.",
      );
    }
    const event = this.stripe.webhooks.constructEvent(rawBody, signature, this.webhookSecret);
    const result: WebhookParseResult = {
      event_id: event.id,
      event_type: event.type,
      fulfillment: null,
    };
    if (event.type !== "checkout.session.completed") {
      return result;
    }
    const session = event.data.object as Stripe.Checkout.Session;
    /* Only fulfill paid sessions. Async payment methods (bank
     * debits, etc.) can fire session.completed with payment_status
     * != 'paid'; those are picked up by checkout.session.async_payment_succeeded
     * which we currently don't subscribe to (card-only above). Ignore
     * defensively. */
    if (session.payment_status !== "paid") {
      return result;
    }
    const metadata = session.metadata ?? {};
    const userIdRaw = metadata.user_id;
    const packageId = metadata.package_id;
    const creditsRaw = metadata.credits;
    const amountRaw = metadata.amount_cents ?? String(session.amount_total ?? 0);
    if (!userIdRaw || !packageId || !creditsRaw) {
      /* Missing metadata almost always means this session wasn't
       * created by our backend (e.g. someone reusing the same
       * STRIPE_SECRET_KEY for another product, or a Dashboard test
       * session). Ack without fulfilling. */
      return result;
    }
    const user_id = Number(userIdRaw);
    const credits = Number(creditsRaw);
    const amount_cents = Number(amountRaw);
    const pkg = findCreditPackage(packageId);
    if (!pkg) return result;
    /* Defense-in-depth: the metadata `credits` value must match what
     * the catalog says the package grants. Otherwise reject the
     * fulfillment payload \u2014 someone tampered with the session at
     * creation time. */
    if (!Number.isFinite(user_id) || credits !== pkg.credits) {
      return result;
    }
    const promoMetadata = typeof metadata.promo === "string" && metadata.promo.length > 0 ? metadata.promo : null;
    result.fulfillment = {
      session_id: session.id,
      package: pkg,
      user_id,
      credits,
      amount_cents: Number.isFinite(amount_cents) ? amount_cents : pkg.price_cents,
      customer_email: session.customer_details?.email ?? session.customer_email ?? undefined,
      promo_name: promoMetadata,
    };
    return result;
  }
}

/* Append a `stripe-session=...` parameter to the configured success URL
 * so the Credits page can show a "verifying purchase" state when the
 * buyer lands back. Hash routes like `/#/credits` need the param after
 * the hash; this helper handles both shapes. */
function appendStripeSessionParam(url: string): string {
  return appendStatusToUrl(url, [
    ["status", "stripe-success"],
    ["session_id", "{CHECKOUT_SESSION_ID}"],
  ]);
}
function appendStripeStatusParam(url: string, status: string): string {
  return appendStatusToUrl(url, [["status", `stripe-${status}`]]);
}
function appendStatusToUrl(url: string, params: Array<[string, string]>): string {
  /* If the URL contains a hash (`#/credits`), append params to the
   * hash search portion so the SPA can read them via location.hash.
   * Otherwise append to the standard search part. We keep the
   * Stripe-templated `{CHECKOUT_SESSION_ID}` placeholder intact \u2014
   * Stripe substitutes it server-side before redirecting. */
  const hashIndex = url.indexOf("#");
  if (hashIndex === -1) {
    const sep = url.includes("?") ? "&" : "?";
    const query = params.map(([k, v]) => `${encodeURIComponent(k)}=${v}`).join("&");
    return `${url}${sep}${query}`;
  }
  const base = url.slice(0, hashIndex);
  const hash = url.slice(hashIndex); // includes leading '#'
  const hasHashQuery = hash.includes("?");
  const sep = hasHashQuery ? "&" : "?";
  const query = params.map(([k, v]) => `${encodeURIComponent(k)}=${v}`).join("&");
  return `${base}${hash}${sep}${query}`;
}

/* =====================================================================
 * Live providers \u2014 Lemon Squeezy stub kept in place.
 * ===================================================================== */
class UnimplementedLemonSqueezyProvider implements PaymentProvider {
  readonly name = "lemonsqueezy";
  readonly isPreview = false;
  readonly displayName = "Lemon Squeezy";
  listPackages(): CreditPackage[] { return CREDIT_PACKAGES; }
  async createCheckout(): Promise<CreateCheckoutResult> {
    throw new Error("Lemon Squeezy provider not configured in this build");
  }
  async verifySession(): Promise<VerifySessionResult> {
    throw new Error("Lemon Squeezy provider not configured in this build");
  }
}

/* =====================================================================
 * Provider selection
 *
 * PAYMENT_PROVIDER env var picks the active provider. Defaults to
 * "preview" for the unconfigured preview build. Production deployments
 * set PAYMENT_PROVIDER=stripe (or =lemonsqueezy) and wire the real SDK
 * inside the corresponding class above.
 * ===================================================================== */
function resolveProvider(): PaymentProvider {
  const requested = (process.env.PAYMENT_PROVIDER ?? "preview").toLowerCase();
  switch (requested) {
    case "stripe":
      try {
        return new StripePaymentProvider();
      } catch (err: any) {
        console.error("[payments] Stripe provider failed to initialize:", err?.message ?? err);
        console.error("[payments] Falling back to preview provider. Fix the configuration and restart.");
        return new PreviewPaymentProvider();
      }
    case "lemonsqueezy":
    case "lemon-squeezy":
      return new UnimplementedLemonSqueezyProvider();
    case "preview":
    default:
      return new PreviewPaymentProvider();
  }
}

export const paymentProvider: PaymentProvider = resolveProvider();

/* Test-only: build a fresh Stripe provider against an explicit secret.
 * Used by script/verify-stripe-webhook.ts to unit-test the signature
 * verification path without touching the live `paymentProvider`
 * singleton or the network. The factory short-circuits Stripe API
 * calls because the test only invokes parseWebhookEvent(), which is
 * pure local crypto. */
export function _createStripeProviderForTest(opts: {
  secret_key: string;
  webhook_secret: string;
}): PaymentProvider {
  const prev = {
    secret: process.env.STRIPE_SECRET_KEY,
    webhook: process.env.STRIPE_WEBHOOK_SECRET,
  };
  process.env.STRIPE_SECRET_KEY = opts.secret_key;
  process.env.STRIPE_WEBHOOK_SECRET = opts.webhook_secret;
  try {
    return new StripePaymentProvider();
  } finally {
    if (prev.secret === undefined) delete process.env.STRIPE_SECRET_KEY;
    else process.env.STRIPE_SECRET_KEY = prev.secret;
    if (prev.webhook === undefined) delete process.env.STRIPE_WEBHOOK_SECRET;
    else process.env.STRIPE_WEBHOOK_SECRET = prev.webhook;
  }
}
