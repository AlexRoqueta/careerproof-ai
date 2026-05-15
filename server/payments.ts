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
import { CREDIT_PACKAGES, findCreditPackage, type CreditPackage } from "@shared/entitlements";

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
    const session_id = `preview_${Date.now().toString(36)}_${randomBytes(6).toString("hex")}`;
    const token = signPreviewToken({ session_id, package_id: pkg.id });
    /* Build a URL that loops back through the app's success_url with
     * the fields the verify endpoint needs. The frontend success page
     * POSTs to /api/payments/complete-checkout with these fields and
     * the route handler calls verifySession before granting credits. */
    const url = new URL(input.success_url);
    url.searchParams.set("status", "preview-success");
    url.searchParams.set("session_id", session_id);
    url.searchParams.set("package_id", pkg.id);
    url.searchParams.set("token", token);
    return {
      checkout_url: url.toString(),
      session_id,
      package_id: pkg.id,
      provider: this.name,
      preview: true,
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
 * Live providers \u2014 not implemented in this preview build.
 *
 * Stub classes intentionally throw so a misconfigured environment
 * surfaces clearly rather than silently falling back to preview mode.
 * Drop in the real SDK calls when wiring production. See the handoff
 * for the exact integration points.
 * ===================================================================== */
class UnimplementedStripeProvider implements PaymentProvider {
  readonly name = "stripe";
  readonly isPreview = false;
  readonly displayName = "Stripe Checkout";
  listPackages(): CreditPackage[] { return CREDIT_PACKAGES; }
  async createCheckout(): Promise<CreateCheckoutResult> {
    throw new Error("Stripe provider not configured in this build");
  }
  async verifySession(): Promise<VerifySessionResult> {
    throw new Error("Stripe provider not configured in this build");
  }
}

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
      return new UnimplementedStripeProvider();
    case "lemonsqueezy":
    case "lemon-squeezy":
      return new UnimplementedLemonSqueezyProvider();
    case "preview":
    default:
      return new PreviewPaymentProvider();
  }
}

export const paymentProvider: PaymentProvider = resolveProvider();
