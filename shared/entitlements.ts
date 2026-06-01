export const UNLIMITED_CREDIT_EMAILS = ["roqueta.alex@gmail.com"];

/* Promo codes are intentionally case-insensitive on the server.
 * The single redemption rule is enforced server-side via the credit
 * ledger — not via a stored "redeemed" flag on the user. */
export const FREE_CREDITS_PROMO_CODE = "10FREE";
export const FREE_CREDITS_PROMO_AMOUNT = 10;

/* Welcome bonus granted at signup. Set to 0 because the free
 * experience is now a locked "preview" report (header + score + a
 * small teaser) rather than a full free report. Users unlock the
 * full report by buying a credit pack ($3 / $7 / $10). Existing users
 * are unaffected — the grant happens once, inline with createUser,
 * and is recorded on the ledger as reason='signup_bonus'. */
export const SIGNUP_BONUS_CREDITS = 0;

export function hasUnlimitedCredits(email?: string | null, role?: string | null): boolean {
  if (role === "admin") return true;
  const normalized = email?.trim().toLowerCase();
  return !!normalized && UNLIMITED_CREDIT_EMAILS.includes(normalized);
}

/* =====================================================================
 * Free first full report (free-first growth model)
 *
 * Every account gets ONE free full report — no credit card, no credit
 * spend. This is the core of the free-first funnel: cold traffic runs an
 * anonymous preview, signs up, and unlocks their first full report for
 * free. The 2nd+ report costs a credit (the credit packs below).
 *
 * Enforcement is ledger-based, NOT a column on the user row. The first
 * free unlock appends a zero-delta credit_transactions row with
 * reason='free_report_claim' and reference='analysis:<id>'. The presence
 * of any such row means "this account already used its free report". A
 * zero-delta row is used (rather than a +1/-1 pair) so the credit balance
 * is never inflated — the free report is an entitlement, not a credit.
 *
 * This avoids a schema migration (reuses credit_transactions) and gives
 * an immutable audit trail of which analysis the free unlock applied to.
 *
 * Unlimited accounts (admins / entitled emails) never consume the free
 * report — they unlock everything for free and we don't record a row.
 * ===================================================================== */
export const FREE_FIRST_REPORT_REASON = "free_report_claim";
export const FREE_FIRST_REPORT_ENABLED = true;

/* =====================================================================
 * Credit package catalog
 *
 * This is the SINGLE source of truth for credit packages — referenced
 * by both the Credits page (price tiles, checkout button) and the
 * payment provider on the server (price lookup, ledger entries).
 *
 * `id` is opaque and stable; it is what the client posts to the
 * /api/payments/create-checkout endpoint and what the ledger records
 * as the purchase reference. Production deployments should keep the
 * id stable across provider changes so old transaction history rows
 * still resolve to a human label.
 *
 * `price_cents` is purely informational here. The chosen payment
 * provider is the authoritative source for what the buyer is charged.
 * ===================================================================== */
export interface CreditPackage {
  id: string;
  name: string;
  description: string;
  credits: number;
  price_cents: number;
  currency: "USD";
  popular?: boolean;
}

export const CREDIT_PACKAGES: CreditPackage[] = [
  {
    id: "starter_1",
    name: "Starter",
    description: "Unlock 1 full AI Exposure Report",
    credits: 1,
    price_cents: 300,
    currency: "USD",
  },
  {
    id: "standard_3",
    name: "Standard",
    description: "Unlock 3 full reports — most popular",
    credits: 3,
    price_cents: 700,
    currency: "USD",
    popular: true,
  },
  {
    id: "value_5",
    name: "Value Pack",
    description: "Unlock 5 full reports — best per-credit price",
    credits: 5,
    price_cents: 1000,
    currency: "USD",
  },
];

export function findCreditPackage(id: string): CreditPackage | undefined {
  return CREDIT_PACKAGES.find((p) => p.id === id);
}

export function formatPrice(price_cents: number, currency: "USD" = "USD"): string {
  const dollars = price_cents / 100;
  const formatted = dollars.toLocaleString("en-US", {
    minimumFractionDigits: dollars % 1 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  });
  return `$${formatted} ${currency}`;
}
