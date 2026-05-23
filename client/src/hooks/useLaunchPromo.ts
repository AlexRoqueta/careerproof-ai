import { useQuery } from "@tanstack/react-query";
import {
  getLaunchPromoCopy,
  getLaunchPromoRemaining,
  type LaunchPromoCopy,
  type LaunchPromoState,
} from "@shared/launchPromo";
import type { CreditPackage } from "@shared/entitlements";

interface PackagesResponse {
  packages: CreditPackage[];
  provider: {
    name: string;
    display_name: string;
    is_preview: boolean;
  };
  launch_promo?: LaunchPromoState;
  launch_promo_copy?: LaunchPromoCopy;
}

/* useLaunchPromo
 *
 * Reads `launch_promo` (and pre-built copy) from /api/payments/packages.
 * This is the single client-side entry point for any surface that needs
 * to know whether the launch promo is live — landing CTA, locked report
 * banner, anonymous preview, buy-credits modal, credits page. Re-using
 * the existing /api/payments/packages query means we never fire an
 * extra round trip; pages that already render the packages grid share
 * the cached response.
 */
export function useLaunchPromo() {
  const q = useQuery<PackagesResponse>({
    queryKey: ["/api/payments/packages"],
  });
  const state: LaunchPromoState | undefined = q.data?.launch_promo;
  const copy: LaunchPromoCopy | undefined =
    q.data?.launch_promo_copy ?? (state ? getLaunchPromoCopy(state) : undefined);
  /* Compute the trustworthy "remaining slots" number once at the hook
   * boundary so every UI surface uses the same value. `null` means
   * "do not render a counter" (promo inactive, or count unknown) —
   * never substitute a fake number when this is null. */
  const remaining = getLaunchPromoRemaining(state);
  return {
    /** Resolved promo state (env + DB count) — undefined while loading. */
    promo: state,
    /** True when the promo is live AND slots remain. */
    active: !!state?.active,
    /** Pre-baked copy strings (headline / CTA / tagline). */
    copy,
    /**
     * Number of $1 launch discounts still available, or null when the
     * count is unknown / promo inactive. Render the counter only when
     * this is a positive integer.
     */
    remaining,
    /** React Query loading flag for surfaces that want a placeholder. */
    isLoading: q.isLoading,
  };
}
