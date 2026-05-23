/* =====================================================================
 * Server-side launch promo helpers
 *
 * Resolves the env-driven launch promo configuration, counts ledger
 * redemptions, and returns a single structured `LaunchPromoState` that
 * the API, the payment provider, and the analytics layer all consume.
 *
 * Counting is done by scanning purchase rows whose `reference` ledger
 * column contains a promo tag (`:promo=<name>`). The tag is appended
 * to the reference at fulfillment time in `server/payments.ts` and the
 * webhook handler — so a single LIKE query answers "how many promo
 * unlocks have been redeemed" without a separate counter table or a
 * schema migration. See shared/launchPromo.ts for the suffix helper.
 * ===================================================================== */
import {
  readLaunchPromoEnv,
  promoReferenceSuffix,
  LAUNCH_PROMO_TARGET_PACKAGE_ID,
  type LaunchPromoState,
} from "@shared/launchPromo";
import { storage } from "./storage";

/* Resolve the current promo state. Hits the DB to count redemptions —
 * the caller should call this lazily (e.g. inside route handlers /
 * createCheckout) so a single startup misconfiguration does not lock
 * the count in. Failures from the DB lookup degrade gracefully: the
 * count is omitted and `active` reflects only the env flag + a fresh
 * read of the limit, so the operator can still gate via env. */
export async function getLaunchPromoState(): Promise<LaunchPromoState> {
  const env = readLaunchPromoEnv();
  let used: number | undefined;
  try {
    used = await storage.countPurchasesByReferenceSubstring(promoReferenceSuffix(env.name));
  } catch (err) {
    console.warn(
      `[launchPromo] failed to count redemptions for promo=${env.name}: ${err instanceof Error ? err.message : String(err)}`,
    );
    used = undefined;
  }
  const slotsRemaining = used !== undefined ? Math.max(0, env.limit - used) : env.limit;
  const active = env.enabled && env.limit > 0 && slotsRemaining > 0;
  return {
    active,
    name: env.name,
    regular_price_cents: env.regular_price_cents,
    promo_price_cents: env.promo_price_cents,
    limit: env.limit,
    used,
    target_package_id: LAUNCH_PROMO_TARGET_PACKAGE_ID,
  };
}
