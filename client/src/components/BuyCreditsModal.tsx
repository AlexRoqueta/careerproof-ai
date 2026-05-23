import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { CreditCard, Sparkles } from "lucide-react";
import { Link } from "wouter";
import { setPendingUnlockAnalysisId } from "@/lib/pendingUnlock";
import { useLaunchPromo } from "@/hooks/useLaunchPromo";
import { formatCents } from "@shared/launchPromo";
import { track, EVENTS } from "@/lib/analytics";
import { LaunchPromoCounter } from "./LaunchPromoCounter";

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  /* When set, the modal was opened from a locked report. Buying a
   * credit pack should return the user to that exact report and unlock
   * it — no rerun of the analysis. We stash the id in localStorage so
   * it survives a hosted-checkout redirect (Stripe) where the in-memory
   * state would otherwise be lost. */
  targetAnalysisId?: number;
}

export function BuyCreditsModal({ open, onOpenChange, targetAnalysisId }: Props) {
  const fromLockedReport = typeof targetAnalysisId === "number" && targetAnalysisId > 0;
  const { active: promoActive, promo, copy: promoCopy, remaining: promoRemaining } = useLaunchPromo();
  const promoPrice = promo ? formatCents(promo.promo_price_cents) : "$1";
  const regularPrice = promo ? formatCents(promo.regular_price_cents) : "$3";
  const ctaLabel = promoActive
    ? `Unlock My Report for ${promoPrice}`
    : fromLockedReport
      ? "Unlock My Full Report"
      : "View packages";
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="dialog-buy-credits">
        <DialogHeader>
          <div className="h-12 w-12 rounded-lg bg-aurora-light dark:bg-aurora grid place-items-center mb-2">
            <CreditCard className="w-6 h-6 text-primary" />
          </div>
          <DialogTitle>
            {fromLockedReport
              ? "Unlock My Full Report"
              : "Unlock the full AI Exposure Report"}
          </DialogTitle>
          <DialogDescription>
            Unlock the complete roadmap, not just the score. Full report includes:
            task-by-task AI exposure, skills that make you harder to replace, AI
            tools to learn, safer next moves, and a 30/60/90-day action plan.
          </DialogDescription>
        </DialogHeader>
        {promoActive && (
          <div
            data-testid="banner-launch-promo"
            className="rounded-lg border border-cyan-400/40 bg-gradient-to-r from-cyan-500/10 via-sky-500/10 to-violet-500/10 px-3 py-2 text-xs leading-relaxed text-foreground/90"
          >
            <div className="flex items-start gap-2">
              <Sparkles className="w-3.5 h-3.5 mt-0.5 text-cyan-300 shrink-0" />
              <div className="min-w-0 flex-1">
                <div className="flex items-start justify-between gap-2 flex-wrap">
                  <div className="font-semibold text-foreground">
                    {promoCopy?.headline ??
                      `Launch offer: First ${promo?.limit ?? 50} customers unlock the full AI Exposure Report for ${promoPrice}. Regular price ${regularPrice}.`}
                  </div>
                  <LaunchPromoCounter data-testid="text-launch-promo-remaining-modal" />
                </div>
                <div className="mt-0.5 text-muted-foreground">
                  {promoCopy?.includes_line ??
                    "Includes your AI exposure score, vulnerable tasks, skills to build, and a 30/60/90-day action plan."}
                </div>
              </div>
            </div>
          </div>
        )}
        <div className="text-xs text-foreground/80 -mt-1 leading-relaxed">
          A personalized career-risk review from a coach or counselor could cost $75–$300+ per hour.
          CareerProof AI gives you a fast, affordable, role-specific AI Exposure Report
          {promoActive
            ? ` for just ${promoPrice} today (regular ${regularPrice}).`
            : " for just $3."}
        </div>
        <div className="text-xs text-muted-foreground mt-1 mb-2">
          No subscription required · One credit = one full report · Secure checkout powered by Stripe.
          {" "}Directional career-risk insight, not a guarantee.
        </div>
        <div className="flex gap-2 justify-end">
          <Button variant="outline" onClick={() => onOpenChange(false)} data-testid="button-cancel-buy">
            Not now
          </Button>
          <Link href="/credits">
            <Button
              onClick={() => {
                if (fromLockedReport) {
                  setPendingUnlockAnalysisId(targetAnalysisId!);
                }
                track(EVENTS.buy_credits_clicked, {
                  source: "buy_credits_modal",
                  from_locked_report: fromLockedReport,
                  promo_active: promoActive,
                  promo_name: promo?.name ?? null,
                  promo_price: promo ? promo.promo_price_cents / 100 : undefined,
                  regular_price: promo ? promo.regular_price_cents / 100 : 3,
                  promo_limit: promo?.limit,
                  promo_used: promo?.used,
                  promo_remaining: promoRemaining ?? undefined,
                });
                onOpenChange(false);
              }}
              data-testid="button-go-to-credits"
            >
              {ctaLabel}
            </Button>
          </Link>
        </div>
      </DialogContent>
    </Dialog>
  );
}
