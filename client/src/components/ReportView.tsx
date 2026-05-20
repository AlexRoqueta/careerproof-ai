import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Download, Share2, Lock, Sparkles, Loader2 } from "lucide-react";
import type { Analysis } from "@shared/schema";
import { formatDateTime, toTitleCase } from "@/lib/format";
import { useToast } from "@/hooks/use-toast";
import { useEffect, useState } from "react";
import { ShareModal } from "./ShareModal";
import { BuyCreditsModal } from "./BuyCreditsModal";
import { useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useMe } from "@/hooks/useMe";
import { hasUnlimitedCredits } from "@shared/entitlements";
import { VisualReport } from "./VisualReport";
import { track, EVENTS } from "@/lib/analytics";

interface Props {
  analysis: Analysis;
  onAnalysisUpdated?: (analysis: Analysis) => void;
}

export function ReportView({ analysis, onAnalysisUpdated }: Props) {
  const { toast } = useToast();
  const [shareOpen, setShareOpen] = useState(false);
  const [buyOpen, setBuyOpen] = useState(false);
  const { data: me } = useMe();
  const unlimited = hasUnlimitedCredits(me?.email, me?.role);
  const canSpend = unlimited || (me?.credits ?? 0) > 0;

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
  }, [analysis.id, isLocked, analysis.risk_score]);

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
          className="border-amber-500/30 bg-amber-500/10 p-4 rounded-2xl"
          data-testid="banner-locked"
        >
          <div className="flex items-start gap-3">
            <Lock className="w-5 h-5 text-amber-300 shrink-0 mt-0.5" />
            <div className="flex-1">
              <p className="text-sm font-semibold text-foreground">
                Body content is blurred until you unlock
              </p>
              <p className="text-xs text-muted-foreground mt-1">
                The report header, automation score, charts, and section titles are
                visible. Unlock the full readable report by using a credit or buying
                more.
              </p>
              <div className="flex flex-wrap gap-2 mt-3">
                {canSpend ? (
                  <Button
                    size="sm"
                    onClick={() => unlockMutation.mutate()}
                    disabled={unlockMutation.isPending}
                    data-testid="button-unlock-report"
                  >
                    {unlockMutation.isPending ? (
                      <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
                    ) : (
                      <Sparkles className="w-3.5 h-3.5 mr-1.5" />
                    )}
                    {unlimited ? "Unlock report" : "Use 1 credit to unlock"}
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    onClick={() => {
                      track(EVENTS.buy_credits_clicked, { source: "locked_report" });
                      setBuyOpen(true);
                    }}
                    data-testid="button-buy-credits-unlock"
                  >
                    <Sparkles className="w-3.5 h-3.5 mr-1.5" />
                    Buy credits to unlock
                  </Button>
                )}
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
                  Want to compare another role?
                </p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Buy 1 more report for just $3. No subscription — one credit = one full report.
                  Secure checkout powered by Stripe.
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
      <BuyCreditsModal open={buyOpen} onOpenChange={setBuyOpen} />
    </div>
  );
}
