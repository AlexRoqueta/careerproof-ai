import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { CreditCard } from "lucide-react";
import { Link } from "wouter";

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}

export function BuyCreditsModal({ open, onOpenChange }: Props) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="dialog-buy-credits">
        <DialogHeader>
          <div className="h-12 w-12 rounded-lg bg-aurora-light dark:bg-aurora grid place-items-center mb-2">
            <CreditCard className="w-6 h-6 text-primary" />
          </div>
          <DialogTitle>Unlock the full AI Exposure Report</DialogTitle>
          <DialogDescription>
            One credit unlocks one full report — detailed task breakdown, skills to
            build, safer next moves, 90-day action plan, and PDF export. Start at
            $3 for 1 report ($7 for 3, $10 for 5).
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
            <Button onClick={() => onOpenChange(false)} data-testid="button-go-to-credits">
              View packages
            </Button>
          </Link>
        </div>
      </DialogContent>
    </Dialog>
  );
}
