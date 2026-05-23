import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { CreditCard } from "lucide-react";
import { Link } from "wouter";
import { setPendingUnlockAnalysisId } from "@/lib/pendingUnlock";

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
            {fromLockedReport
              ? "Your preview is saved. Pick a credit pack and we'll bring you straight back to this exact report and unlock it automatically — no rerun, no re-entry. Less than a latte — $3 for 1 report ($7 for 3, $10 for 5)."
              : "One credit unlocks one full report — tasks most exposed to AI, skills that make you harder to replace, AI tools to learn now, safer career moves to consider, and a 30 / 60 / 90-day plan. Less than a latte — $3 for 1 report ($7 for 3, $10 for 5)."}
          </DialogDescription>
        </DialogHeader>
        <div className="text-xs text-muted-foreground -mt-2 mb-2">
          No subscription required · One credit = one full report · Secure checkout powered by Stripe.
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
                onOpenChange(false);
              }}
              data-testid="button-go-to-credits"
            >
              {fromLockedReport ? "Unlock My Full Report" : "View packages"}
            </Button>
          </Link>
        </div>
      </DialogContent>
    </Dialog>
  );
}
