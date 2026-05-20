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
          <DialogTitle>You're out of credits</DialogTitle>
          <DialogDescription>
            Each AI assessment uses one credit. Top up to keep analyzing — start at just $3 for a single report.
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
