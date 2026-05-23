import { Sparkles } from "lucide-react";
import { useLaunchPromo } from "@/hooks/useLaunchPromo";
import { formatCents } from "@shared/launchPromo";

/* LaunchPromoCounter
 *
 * Renders a real, server-derived "{remaining} of {limit} launch
 * discounts left" pill near a launch-offer surface. It returns null
 * (and therefore renders nothing) unless we have a positive,
 * server-counted `remaining` value — no fake or random scarcity.
 *
 * Variants:
 *   - "pill"    — small inline chip, suits dense banners (locked
 *                 report banner, anonymous preview, hero pill)
 *   - "inline"  — a bare line of text without background; useful when
 *                 the parent already supplies a container with promo
 *                 styling (BuyCreditsModal description, FAQ bodies)
 *   - "block"   — larger card-style block, used by the Credits page
 *                 next to the price tiles
 *
 * Optional `tone` tightens the urgency when the count gets small
 * without lying about the number: at ≤10 left we promote to amber.
 */
export interface LaunchPromoCounterProps {
  variant?: "pill" | "inline" | "block";
  className?: string;
  /** Override the rendered phrasing while keeping the truthful number. */
  format?: "default" | "only";
  "data-testid"?: string;
}

export function LaunchPromoCounter({
  variant = "pill",
  className = "",
  format = "default",
  ...rest
}: LaunchPromoCounterProps) {
  const { active, remaining, promo } = useLaunchPromo();
  if (!active) return null;
  if (remaining === null) return null;
  if (remaining <= 0) return null;
  const limit = promo?.limit ?? 50;
  const promoPrice = promo ? formatCents(promo.promo_price_cents) : "$1";
  const urgent = remaining <= Math.min(10, Math.max(1, Math.floor(limit / 5)));
  const text =
    format === "only"
      ? `Only ${remaining} launch discount${remaining === 1 ? "" : "s"} left at ${promoPrice}`
      : `${remaining} of ${limit} launch discount${remaining === 1 ? "" : "s"} left`;
  const testId = (rest as any)["data-testid"] ?? "text-launch-promo-remaining";

  if (variant === "inline") {
    return (
      <span
        className={`text-[11px] font-medium ${urgent ? "text-amber-200" : "text-cyan-200/90"} ${className}`}
        data-testid={testId}
      >
        {text}
      </span>
    );
  }
  if (variant === "block") {
    return (
      <div
        className={`rounded-lg border ${urgent ? "border-amber-400/40 bg-amber-500/10" : "border-cyan-400/40 bg-cyan-500/10"} px-3 py-2 text-xs flex items-start gap-2 ${className}`}
        data-testid={testId}
      >
        <Sparkles className={`w-3.5 h-3.5 mt-0.5 shrink-0 ${urgent ? "text-amber-300" : "text-cyan-300"}`} />
        <span className="text-foreground/90 font-medium">{text}</span>
      </div>
    );
  }
  // pill (default)
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${
        urgent
          ? "border-amber-400/40 bg-amber-500/10 text-amber-200"
          : "border-cyan-400/40 bg-cyan-500/10 text-cyan-200"
      } ${className}`}
      data-testid={testId}
    >
      <Sparkles className="w-2.5 h-2.5" />
      {text}
    </span>
  );
}
