/* =====================================================================
 * Launch promo — single source of truth for promo copy + math
 *
 * The launch promo discounts the single-credit ("starter_1") package
 * from the regular price (default $3) to a launch price (default $1)
 * for the first N paid full-report unlocks. Everything is env-driven
 * so the promo can be turned off, retuned, or extended without code
 * changes.
 *
 * Server-only env vars (also surfaced to the client via
 * GET /api/payments/packages, which echoes them as a structured
 * `launch_promo` object — the secrets are not):
 *
 *   LAUNCH_PROMO_ENABLED            "1" | "0"        (default "1")
 *   LAUNCH_PROMO_LIMIT              integer, >= 0    (default 50)
 *   LAUNCH_PROMO_CREDIT_PRICE_CENTS integer, > 0     (default 100  = $1)
 *   REGULAR_SINGLE_CREDIT_PRICE_CENTS integer, > 0   (default 300  = $3)
 *   LAUNCH_PROMO_NAME               short identifier (default "launch50")
 *   LAUNCH_PROMO_STRIPE_PRICE_ID    optional Stripe price id; not
 *                                   currently required (we use inline
 *                                   price_data) but reserved for
 *                                   operators who insist on managing
 *                                   the discounted price in their
 *                                   Stripe Dashboard.
 *
 * The ID of the single-credit package that the promo discounts is
 * pinned to the catalog id below. If the operator renames the catalog
 * entry, update this constant too.
 * ===================================================================== */

export const LAUNCH_PROMO_TARGET_PACKAGE_ID = "starter_1";

/* Default regular & promo pricing, applied when env vars are unset.
 * Keep these in sync with the catalog entry for starter_1 in
 * shared/entitlements.ts — the catalog is the price tile displayed
 * pre-discount and the regular fallback when the promo is exhausted
 * or disabled. */
export const DEFAULT_REGULAR_SINGLE_CREDIT_PRICE_CENTS = 300;
export const DEFAULT_LAUNCH_PROMO_PRICE_CENTS = 100;
export const DEFAULT_LAUNCH_PROMO_LIMIT = 50;
export const DEFAULT_LAUNCH_PROMO_NAME = "launch50";

/* Public, structured description of the promo state. Returned by the
 * server on every /api/payments/packages request so the client can
 * decide which copy + CTA wording to render in a single place. */
export interface LaunchPromoState {
  /** True when the operator has enabled the promo AND there are slots left. */
  active: boolean;
  /** Promo name identifier (analytics + ledger tag). */
  name: string;
  /** Regular per-credit price in cents. */
  regular_price_cents: number;
  /** Promotional per-credit price in cents. */
  promo_price_cents: number;
  /** Maximum number of times the promo can be redeemed. */
  limit: number;
  /**
   * Promo redemptions counted so far. May be omitted when the
   * counting source is unavailable (e.g. ledger query failure) —
   * callers should treat undefined as "unknown, do not display a
   * countdown".
   */
  used?: number;
  /** Catalog id of the single-credit package the promo discounts. */
  target_package_id: string;
}

/* Centralized copy. All conversion surfaces should pull from here so a
 * later wording change happens in one file rather than five. */
export interface LaunchPromoCopy {
  /** Short headline, e.g. "Launch offer: $1 for your first full report". */
  headline: string;
  /** One-line value proposition, regular price + scarcity. */
  tagline: string;
  /** Long-form value list of what unlocking includes. */
  includes_line: string;
  /** CTA button label when the promo is active. */
  cta_label: string;
  /** CTA button label when the promo is NOT active. */
  fallback_cta_label: string;
  /** Short price comparator e.g. "$1 today · regular $3" */
  price_comparator: string;
}

export function getLaunchPromoCopy(state: LaunchPromoState): LaunchPromoCopy {
  const regularStr = formatCents(state.regular_price_cents);
  const promoStr = formatCents(state.promo_price_cents);
  const headline = state.active
    ? `Launch offer: First ${state.limit} customers unlock the full AI Exposure Report for ${promoStr}. Regular price ${regularStr}.`
    : `Unlock the full AI Exposure Report for ${regularStr}.`;
  const tagline = state.active
    ? `Limited launch pricing — ${promoStr} today, ${regularStr} after the first ${state.limit} customers.`
    : `One credit unlocks one full AI Exposure Report — ${regularStr}.`;
  return {
    headline,
    tagline,
    includes_line:
      "Includes your AI exposure score, vulnerable tasks, skills to build, and a 30/60/90-day action plan.",
    cta_label: state.active ? `Unlock My Report for ${promoStr}` : `Unlock My Full Report for ${regularStr}`,
    fallback_cta_label: `Unlock My Full Report for ${regularStr}`,
    price_comparator: state.active
      ? `${promoStr} today · regular ${regularStr}`
      : `${regularStr} · one credit = one full report`,
  };
}

/* Compute the number of launch-discount slots still available.
 *
 * Returns:
 *   - a non-negative integer when the promo is active, `used` is known,
 *     and at least one slot is left
 *   - 0 when the promo would otherwise be active but all slots are
 *     gone (callers should treat this as "no counter, fall back to
 *     regular pricing copy")
 *   - null when the count is unknown (DB lookup failed) or the promo
 *     is inactive — callers should NOT render a counter in that case
 *
 * Keeping this in shared/ means client and server can both call it.
 * The client receives `state.used` from /api/payments/packages; the
 * server fills `used` in via `getLaunchPromoState()` before responding.
 *
 * Important: the counter should ONLY be rendered when this returns a
 * positive integer. A null return means "we cannot truthfully say how
 * many are left" — the requirement is explicit that no fake/random
 * scarcity is ever shown.
 */
export function getLaunchPromoRemaining(state: LaunchPromoState | undefined | null): number | null {
  if (!state) return null;
  if (!state.active) return null;
  if (typeof state.used !== "number" || !Number.isFinite(state.used)) return null;
  if (!Number.isFinite(state.limit) || state.limit <= 0) return null;
  return Math.max(0, state.limit - state.used);
}

/* Format a cents-integer as "$1" / "$3" / "$3.50". Avoids decimal noise
 * for whole-dollar prices so the copy doesn't read as "$1.00" in body
 * text. */
export function formatCents(cents: number): string {
  if (!Number.isFinite(cents) || cents < 0) return "$0";
  const dollars = cents / 100;
  if (dollars % 1 === 0) return `$${dollars.toFixed(0)}`;
  return `$${dollars.toFixed(2)}`;
}

/* Parse server-side env config. Pure: takes process.env, returns a
 * structured object. The `used` field is filled in by the caller from
 * the ledger (server only) — clients receive it pre-populated by the
 * API. */
export interface LaunchPromoEnv {
  enabled: boolean;
  limit: number;
  regular_price_cents: number;
  promo_price_cents: number;
  name: string;
  stripe_price_id: string | null;
}

export function readLaunchPromoEnv(env: NodeJS.ProcessEnv = process.env): LaunchPromoEnv {
  const enabledRaw = (env.LAUNCH_PROMO_ENABLED ?? "1").trim();
  const enabled = enabledRaw === "1" || enabledRaw.toLowerCase() === "true";
  const limit = parsePositiveInt(env.LAUNCH_PROMO_LIMIT, DEFAULT_LAUNCH_PROMO_LIMIT);
  const promo_price_cents = parsePositiveInt(
    env.LAUNCH_PROMO_CREDIT_PRICE_CENTS,
    DEFAULT_LAUNCH_PROMO_PRICE_CENTS,
  );
  const regular_price_cents = parsePositiveInt(
    env.REGULAR_SINGLE_CREDIT_PRICE_CENTS,
    DEFAULT_REGULAR_SINGLE_CREDIT_PRICE_CENTS,
  );
  const name = (env.LAUNCH_PROMO_NAME ?? DEFAULT_LAUNCH_PROMO_NAME).trim() || DEFAULT_LAUNCH_PROMO_NAME;
  const stripe_price_id = (env.LAUNCH_PROMO_STRIPE_PRICE_ID ?? "").trim() || null;
  return { enabled, limit, regular_price_cents, promo_price_cents, name, stripe_price_id };
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === null || String(raw).trim() === "") return fallback;
  const n = Number(String(raw).trim());
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) return fallback;
  return n;
}

/* Helper used by the ledger reference column so promo purchases can
 * be counted later without scanning every row. */
export function promoReferenceSuffix(promoName: string): string {
  return `:promo=${promoName}`;
}

export function referenceHasPromoTag(reference: string | null | undefined, promoName: string): boolean {
  if (!reference) return false;
  return reference.includes(promoReferenceSuffix(promoName));
}
