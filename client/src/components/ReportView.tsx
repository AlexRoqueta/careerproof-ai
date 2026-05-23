import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Download, Share2, Lock, Sparkles, Loader2, AlertTriangle } from "lucide-react";
import type { Analysis } from "@shared/schema";
import { formatDateTime, toTitleCase } from "@/lib/format";
import { useToast } from "@/hooks/use-toast";
import { useEffect, useState } from "react";
import { ShareModal } from "./ShareModal";
import { BuyCreditsModal } from "./BuyCreditsModal";
import { FeedbackModal } from "./FeedbackModal";
import { useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useMe } from "@/hooks/useMe";
import { hasUnlimitedCredits } from "@shared/entitlements";
import { VisualReport } from "./VisualReport";
import { track, EVENTS } from "@/lib/analytics";

/* Server-attached payload for locked analyses. Only present when
 * the analysis is locked — it carries a short summary, the top 2-3
 * task titles, and the names of the sections still gated behind the
 * paywall. See buildAnalysisPreview() on the server. */
export interface AnalysisPreview {
  summary: string;
  vulnerable_tasks: string[];
  locked_sections: string[];
}

interface Props {
  // We widen the Analysis type with the optional preview payload the
  // server attaches for locked rows. Existing call sites that pass a
  // plain Analysis still type-check.
  analysis: Analysis & { preview?: AnalysisPreview };
  onAnalysisUpdated?: (analysis: Analysis) => void;
}

/* localStorage key for "we've already shown feedback for this analysis".
 * Per-analysis so the modal can re-prompt if the user runs a second
 * preview, but doesn't nag on the same one. */
const FEEDBACK_SHOWN_KEY_PREFIX = "cp.feedback_shown:";
function hasShownFeedbackFor(id: number): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(FEEDBACK_SHOWN_KEY_PREFIX + id) === "1";
  } catch {
    return false;
  }
}
function markFeedbackShown(id: number) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(FEEDBACK_SHOWN_KEY_PREFIX + id, "1");
  } catch {
    /* localStorage might be unavailable in private mode — non-fatal */
  }
}

export function ReportView({ analysis, onAnalysisUpdated }: Props) {
  const { toast } = useToast();
  const [shareOpen, setShareOpen] = useState(false);
  const [buyOpen, setBuyOpen] = useState(false);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const { data: me } = useMe();
  const unlimited = hasUnlimitedCredits(me?.email, me?.role);
  const canSpend = unlimited || (me?.credits ?? 0) > 0;
  const preview = analysis.preview;

  const unlockMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/analyses/${analysis.id}/unlock`);
      return (await res.json()) as Analysis;
    },
    onSuccess: async (updated) => {
      queryClient.setQueryData(["/api/analyses", analysis.id], updated);
      await queryClient.invalidateQueries({ queryKey: ["/api/analyses"] });
      await queryClient.invalidateQueries({ queryKey: ["/api/me"] });
      await queryClient.invalidateQueries({ queryKey: ["/api/credits/transactions"] });
      onAnalysisUpdated?.(updated);
      toast({ title: "Report unlocked" });
    },
    onError: (err: any) => {
      const raw = String(err?.message ?? "");
      if (raw.startsWith("402") || raw.includes("insufficient_credits") || raw.includes("don’t have any credits")) {
        toast({
          title: "You’re out of credits",
          description: "Buy a credit pack to unlock this report.",
          variant: "destructive",
        });
        setBuyOpen(true);
      } else {
        toast({ title: "Unable to unlock report", variant: "destructive" });
      }
    },
  });

  const isLocked = Boolean(analysis.is_locked);

  useEffect(() => {
    track(EVENTS.report_viewed, {
      analysis_id: analysis.id,
      locked: isLocked,
      risk_score: analysis.risk_score,
    });
    if (isLocked) {
      const previewParams = {
        analysis_id: analysis.id,
        risk_score: analysis.risk_score,
      };
      track(EVENTS.preview_viewed, previewParams);
      track(EVENTS.preview_report_viewed, previewParams);
    }
  }, [analysis.id, isLocked, analysis.risk_score]);

  /* Trigger the feedback modal once per analysis, a few seconds after
   * the report renders so the user has time to read the preview/score.
   * We mark the analysis as "shown" the moment the modal opens — even
   * if the user dismisses with "Maybe later" — so we never nag twice
   * about the same one. */
  useEffect(() => {
    if (!analysis.id) return;
    if (hasShownFeedbackFor(analysis.id)) return;
    const t = setTimeout(() => {
      setFeedbackOpen(true);
      markFeedbackShown(analysis.id);
    }, 4500);
    return () => clearTimeout(t);
  }, [analysis.id]);

  const exportPdf = () => {
    window.open(`#/report/${analysis.id}`, "_blank");
  };

  const onShare = async () => {
    const url = `${window.location.origin}${window.location.pathname}#/report/${analysis.id}`;
    const title = toTitleCase(analysis.job_title);
    if ((navigator as any).share) {
      try {
        await (navigator as any).share({
          title: `AI Impact Assessment — ${title}`,
          text: `Automation risk: ${analysis.automation_risk} (${analysis.risk_score}/100)`,
          url,
        });
        return;
      } catch {
        /* User cancelled — fall through to modal */
      }
    }
    setShareOpen(true);
  };

  return (
    <div className="space-y-4" data-testid="view-report">
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
        <span>Generated {formatDateTime(analysis.created_date)}</span>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={exportPdf}
            data-testid="button-export-pdf"
            disabled={isLocked}
            title={isLocked ? "Unlock the report to export" : undefined}
          >
            <Download className="w-4 h-4 mr-1.5" />
            Export PDF
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={onShare}
            data-testid="button-share-report"
            disabled={isLocked}
            title={isLocked ? "Unlock the report to share" : undefined}
          >
            <Share2 className="w-4 h-4 mr-1.5" />
            Share
          </Button>
        </div>
      </div>

      {isLocked && (
        <Card
          className="border-cyan-400/30 bg-gradient-to-br from-cyan-500/10 via-sky-500/10 to-violet-500/10 p-4 sm:p-5 rounded-2xl"
          data-testid="banner-locked"
        >
          <div className="flex items-start gap-3">
            <Sparkles className="w-5 h-5 text-cyan-300 shrink-0 mt-0.5" />
            <div className="flex-1 min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-sm font-semibold text-foreground">
                  Your free AI job-risk preview is ready.
                </p>
                <span className="inline-flex items-center rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-amber-300">
                  <Lock className="w-3 h-3 mr-1" /> Full report locked
                </span>
              </div>
              <p className="text-xs sm:text-sm text-muted-foreground mt-1.5 leading-relaxed">
                You're seeing your AI exposure score, a short summary, and the
                tasks most likely to be exposed. Unlock the full AI Exposure
                Report — for less than a latte — and we'll bring you straight
                back to this exact report. No rerun, no re-entry.
              </p>
              <div className="mt-3 rounded-lg border border-cyan-400/20 bg-background/30 p-3">
                <p className="text-[11px] uppercase tracking-wider font-semibold text-cyan-300/90">
                  Unlock the full AI Exposure Report to see:
                </p>
                <ul className="mt-2 grid grid-cols-1 sm:grid-cols-2 gap-1.5 text-xs text-foreground/85">
                  <li className="flex items-start gap-1.5">
                    <Sparkles className="w-3 h-3 mt-0.5 text-cyan-300 shrink-0" />
                    Tasks in your role most exposed to AI
                  </li>
                  <li className="flex items-start gap-1.5">
                    <Sparkles className="w-3 h-3 mt-0.5 text-cyan-300 shrink-0" />
                    Skills that make you harder to replace
                  </li>
                  <li className="flex items-start gap-1.5">
                    <Sparkles className="w-3 h-3 mt-0.5 text-cyan-300 shrink-0" />
                    AI tools to learn now
                  </li>
                  <li className="flex items-start gap-1.5">
                    <Sparkles className="w-3 h-3 mt-0.5 text-cyan-300 shrink-0" />
                    Safer career moves to consider
                  </li>
                  <li className="flex items-start gap-1.5 sm:col-span-2">
                    <Sparkles className="w-3 h-3 mt-0.5 text-cyan-300 shrink-0" />
                    A 30 / 60 / 90-day plan to stay ahead
                  </li>
                </ul>
                <p className="mt-3 text-[11px] text-cyan-200/90 font-medium">
                  Unlock the full report for less than a latte — $3.
                </p>
              </div>

              {preview?.summary && (
                <p className="mt-3 rounded-lg border border-border/60 bg-background/40 p-3 text-sm leading-relaxed" data-testid="text-preview-summary">
                  {preview.summary}
                </p>
              )}

              {preview && preview.vulnerable_tasks.length > 0 && (
                <div className="mt-3" data-testid="list-preview-tasks">
                  <div className="text-[11px] uppercase tracking-wider text-muted-foreground font-semibold">
                    Most vulnerable tasks (preview)
                  </div>
                  <ul className="mt-2 space-y-1.5">
                    {preview.vulnerable_tasks.slice(0, 3).map((t, i) => (
                      <li
                        key={i}
                        className="flex items-start gap-2 text-sm"
                        data-testid={`row-preview-task-${i}`}
                      >
                        <AlertTriangle className="w-3.5 h-3.5 mt-0.5 text-amber-300 shrink-0" />
                        <span>{t}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {preview && preview.locked_sections.length > 0 && (
                <div className="mt-3">
                  <div className="text-[11px] uppercase tracking-wider text-muted-foreground font-semibold">
                    Unlock to read
                  </div>
                  <ul className="mt-2 grid grid-cols-1 sm:grid-cols-2 gap-1.5">
                    {preview.locked_sections.map((s, i) => (
                      <li
                        key={i}
                        className="flex items-start gap-2 text-xs text-muted-foreground"
                      >
                        <Lock className="w-3 h-3 mt-0.5 shrink-0 text-amber-300/80" />
                        <span>{s}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              <div className="flex flex-wrap gap-2 mt-4">
                {canSpend ? (
                  <Button
                    size="sm"
                    onClick={() => {
                      track(EVENTS.unlock_cta_clicked, {
                        source: "preview_banner",
                        analysis_id: analysis.id,
                        method: unlimited ? "entitlement" : "credit",
                      });
                      track(EVENTS.unlock_report_clicked, {
                        source: "preview_banner",
                        analysis_id: analysis.id,
                        method: unlimited ? "entitlement" : "credit",
                      });
                      unlockMutation.mutate();
                    }}
                    disabled={unlockMutation.isPending}
                    data-testid="button-unlock-report"
                  >
                    {unlockMutation.isPending ? (
                      <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
                    ) : (
                      <Sparkles className="w-3.5 h-3.5 mr-1.5" />
                    )}
                    {unlimited ? "Unlock My Full Report" : "Unlock My Full Report (1 credit)"}
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    onClick={() => {
                      track(EVENTS.unlock_cta_clicked, {
                        source: "preview_banner",
                        analysis_id: analysis.id,
                        method: "buy",
                      });
                      track(EVENTS.unlock_report_clicked, {
                        source: "preview_banner",
                        analysis_id: analysis.id,
                        method: "buy",
                      });
                      track(EVENTS.buy_credits_clicked, { source: "locked_report" });
                      setBuyOpen(true);
                    }}
                    data-testid="button-buy-credits-unlock"
                  >
                    <Sparkles className="w-3.5 h-3.5 mr-1.5" />
                    Unlock My Full Report
                  </Button>
                )}
                <span className="self-center text-[11px] text-muted-foreground">
                  Less than a latte — $3 · One credit = one full report
                </span>
              </div>
            </div>
          </div>
        </Card>
      )}

      <VisualReport analysis={analysis} locked={isLocked} />

      {!isLocked && !unlimited && (
        <Card
          className="border-cyan-400/30 bg-gradient-to-br from-cyan-500/10 via-sky-500/10 to-violet-500/10 p-4 rounded-2xl"
          data-testid="banner-upsell"
        >
          <div className="flex flex-col sm:flex-row sm:items-center gap-3 sm:gap-4">
            <div className="flex items-start gap-3 flex-1">
              <Sparkles className="w-5 h-5 text-cyan-300 shrink-0 mt-0.5" />
              <div>
                <p className="text-sm font-semibold text-foreground">
                  Want to unlock another full report?
                </p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  $3 for 1 · $7 for 3 · $10 for 5. No subscription — one credit unlocks
                  one full report. Secure checkout powered by Stripe.
                </p>
              </div>
            </div>
            <Button
              size="sm"
              onClick={() => {
                track(EVENTS.buy_credits_clicked, { source: "post_report_upsell" });
                setBuyOpen(true);
              }}
              data-testid="button-upsell-buy"
              className="shrink-0"
            >
              <Sparkles className="w-3.5 h-3.5 mr-1.5" />
              Buy another report
            </Button>
          </div>
        </Card>
      )}

      <ShareModal
        open={shareOpen}
        onOpenChange={setShareOpen}
        analysis={analysis}
      />
      <BuyCreditsModal
        open={buyOpen}
        onOpenChange={setBuyOpen}
        targetAnalysisId={isLocked ? analysis.id : undefined}
      />
      <FeedbackModal
        open={feedbackOpen}
        onOpenChange={setFeedbackOpen}
        analysisId={analysis.id}
        locked={isLocked}
      />
    </div>
  );
}
