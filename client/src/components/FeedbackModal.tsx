import { useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Star, Loader2, MessageSquare } from "lucide-react";
import { useMutation } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { track, EVENTS } from "@/lib/analytics";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  analysisId?: number | null;
  /** Whether the user is rating a locked free preview or an unlocked full report.
   * Sent to analytics — server pulls the same flag from the analysis row. */
  locked: boolean;
}

/* Post-preview survey modal.
 *
 * UX rules driven by the conversion experiments:
 *   - Show ONCE per analysis (the parent enforces this via
 *     localStorage on analysis_id).
 *   - "Maybe later" is a first-class action — never block the page,
 *     never re-show automatically after dismissal.
 *   - The Submit button is enabled as soon as a rating is picked;
 *     the comment is optional.
 *
 * The recipient email is configured server-side. The client never
 * names a destination — it just POSTs the rating + comment + the
 * analysis id. */
export function FeedbackModal({ open, onOpenChange, analysisId, locked }: Props) {
  const { toast } = useToast();
  const [rating, setRating] = useState<number>(0);
  const [hover, setHover] = useState<number>(0);
  const [comment, setComment] = useState("");

  useEffect(() => {
    if (open) {
      track(EVENTS.feedback_shown, {
        analysis_id: analysisId ?? null,
        locked,
      });
    }
  }, [open, analysisId, locked]);

  // Reset state when the modal closes so a re-open starts clean.
  useEffect(() => {
    if (!open) {
      const t = setTimeout(() => {
        setRating(0);
        setHover(0);
        setComment("");
      }, 200);
      return () => clearTimeout(t);
    }
  }, [open]);

  const submit = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/feedback/analysis", {
        rating,
        comment: comment.trim() || undefined,
        analysis_id: analysisId ?? undefined,
      });
      return (await res.json()) as { ok: boolean; delivered: boolean };
    },
    onSuccess: () => {
      track(EVENTS.feedback_submitted, {
        analysis_id: analysisId ?? null,
        locked,
        rating,
        has_comment: comment.trim().length > 0,
      });
      toast({
        title: "Thanks for the feedback",
        description: "Your rating helps shape what we build next.",
      });
      onOpenChange(false);
    },
    onError: () => {
      toast({
        title: "Couldn't submit feedback",
        description: "Please try again in a moment.",
        variant: "destructive",
      });
    },
  });

  const onMaybeLater = () => {
    track(EVENTS.feedback_dismissed, {
      analysis_id: analysisId ?? null,
      locked,
    });
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={(o) => (o ? onOpenChange(o) : onMaybeLater())}>
      <DialogContent className="sm:max-w-md" data-testid="dialog-feedback">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <MessageSquare className="w-4 h-4 text-primary" />
            Was this analysis useful?
          </DialogTitle>
          <DialogDescription>
            Rate your free preview so we know what's landing — and what to
            improve before you unlock the full report.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="flex items-center justify-center gap-1.5" role="radiogroup" aria-label="Rating">
            {[1, 2, 3, 4, 5].map((n) => {
              const active = (hover || rating) >= n;
              return (
                <button
                  key={n}
                  type="button"
                  role="radio"
                  aria-checked={rating === n}
                  aria-label={`${n} star${n === 1 ? "" : "s"}`}
                  onClick={() => setRating(n)}
                  onMouseEnter={() => setHover(n)}
                  onMouseLeave={() => setHover(0)}
                  onFocus={() => setHover(n)}
                  onBlur={() => setHover(0)}
                  className="p-1.5 rounded-md transition-transform hover:scale-110 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                  data-testid={`button-rating-${n}`}
                >
                  <Star
                    className={`w-7 h-7 transition-colors ${
                      active
                        ? "fill-amber-300 text-amber-300"
                        : "text-muted-foreground"
                    }`}
                  />
                </button>
              );
            })}
          </div>
          <div className="text-center text-xs text-muted-foreground" data-testid="text-rating-hint">
            {rating === 0
              ? "Tap a star to rate"
              : rating <= 2
              ? "Tell us what missed — we read every reply."
              : rating === 3
              ? "What would make it more useful?"
              : "Glad it helped! Anything we should add?"}
          </div>

          <div className="space-y-1.5">
            <label htmlFor="feedback-comment" className="text-xs text-muted-foreground">
              Optional comment
            </label>
            <Textarea
              id="feedback-comment"
              placeholder="What would make this more useful for your career planning?"
              value={comment}
              onChange={(e) => setComment(e.target.value.slice(0, 2000))}
              rows={3}
              className="resize-none"
              data-testid="input-feedback-comment"
            />
          </div>
        </div>

        <DialogFooter className="gap-2 sm:gap-2">
          <Button
            type="button"
            variant="ghost"
            onClick={onMaybeLater}
            disabled={submit.isPending}
            data-testid="button-feedback-later"
          >
            Maybe later
          </Button>
          <Button
            type="button"
            onClick={() => submit.mutate()}
            disabled={rating === 0 || submit.isPending}
            data-testid="button-feedback-submit"
          >
            {submit.isPending ? (
              <Loader2 className="w-4 h-4 mr-2 animate-spin" />
            ) : null}
            Submit
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
