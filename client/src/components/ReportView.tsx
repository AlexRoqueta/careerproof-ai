import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Download, Share2, Brain, Lock, Sparkles, Loader2 } from "lucide-react";
import type { Analysis } from "@shared/schema";
import { Markdown } from "@/lib/markdown";
import { formatDateTime, riskColor, toTitleCase } from "@/lib/format";
import { useToast } from "@/hooks/use-toast";
import { useState } from "react";
import { ShareModal } from "./ShareModal";
import { ProfessionVisual } from "./ProfessionVisual";
import { BuyCreditsModal } from "./BuyCreditsModal";
import { useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useMe } from "@/hooks/useMe";
import { hasUnlimitedCredits } from "@shared/entitlements";

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
      // Update both the cached single-analysis row and any list views,
      // and let the parent surface refresh its own state so the user
      // sees the unblurred body immediately. Also refresh the ledger so
      // the spend row appears in transaction history.
      queryClient.setQueryData(["/api/analyses", analysis.id], updated);
      await queryClient.invalidateQueries({ queryKey: ["/api/analyses"] });
      await queryClient.invalidateQueries({ queryKey: ["/api/me"] });
      await queryClient.invalidateQueries({ queryKey: ["/api/credits/transactions"] });
      onAnalysisUpdated?.(updated);
      toast({ title: "Report unlocked" });
    },
    onError: (err: any) => {
      // 402 = insufficient credits. Surface the actionable message and
      // surface the Buy Credits modal so the user has a one-click path.
      const raw = String(err?.message ?? "");
      if (raw.startsWith("402") || raw.includes("insufficient_credits") || raw.includes("don\u2019t have any credits")) {
        toast({
          title: "You\u2019re out of credits",
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

  const exportPdf = () => {
    // Opens the print-friendly report page; the user can Save as PDF
    // from the browser's print dialog.
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
        // User cancelled — fall through to modal
      }
    }
    setShareOpen(true);
  };

  return (
    <div className="space-y-4" data-testid="view-report">
      <Card className="overflow-hidden">
        <CardHeader className="bg-aurora text-white relative">
          <div className="absolute inset-0 grid-bg opacity-20 pointer-events-none" />
          <div className="relative flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
            <div>
              <div className="inline-flex items-center gap-1.5 rounded-full border border-white/20 bg-white/10 px-2 py-0.5 text-[11px] mb-2">
                <Brain className="w-3 h-3" />
                {displayProvider(analysis.provider_used)}
              </div>
              <h2 className="text-lg font-semibold leading-tight" data-testid="text-report-title">
                {toTitleCase(analysis.job_title)}
              </h2>
              <p className="text-xs text-white/70 mt-1">{formatDateTime(analysis.created_date)}</p>
            </div>
            <div className="flex items-center gap-4">
              <RiskGauge risk={analysis.automation_risk} score={analysis.risk_score} />
            </div>
          </div>
        </CardHeader>
        <CardContent className="pt-5">
          <div className="mb-5">
            <ProfessionVisual
              key={`${analysis.id}-${analysis.job_title}-${analysis.job_description}`}
              title={analysis.job_title}
              description={analysis.job_description}
            />
          </div>
          <div className="flex flex-wrap items-center gap-2 mb-4">
            <span
              className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium ${riskColor(analysis.automation_risk)}`}
              data-testid="badge-risk"
            >
              {analysis.automation_risk} automation potential · {analysis.risk_score}/100
            </span>
            {isLocked && (
              <span
                className="inline-flex items-center gap-1.5 rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-xs font-medium text-amber-700 dark:text-amber-300"
                data-testid="badge-locked"
              >
                <Lock className="w-3 h-3" />
                Preview — body locked
              </span>
            )}
          </div>
          {isLocked && (
            <div
              className="mb-5 rounded-xl border border-amber-500/30 bg-amber-500/10 p-4"
              data-testid="banner-locked"
            >
              <div className="flex items-start gap-3">
                <Lock className="w-5 h-5 text-amber-600 dark:text-amber-300 shrink-0 mt-0.5" />
                <div className="flex-1">
                  <p className="text-sm font-semibold text-foreground">
                    Body content is blurred until you unlock
                  </p>
                  <p className="text-xs text-muted-foreground mt-1">
                    The report header, automation score, and section titles are
                    visible. Unlock the full readable report by using a credit
                    or buying more.
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
                        onClick={() => setBuyOpen(true)}
                        data-testid="button-buy-credits-unlock"
                      >
                        <Sparkles className="w-3.5 h-3.5 mr-1.5" />
                        Buy credits to unlock
                      </Button>
                    )}
                  </div>
                </div>
              </div>
            </div>
          )}
          <Markdown source={analysis.result_text} locked={isLocked} />
          <div className="flex flex-wrap gap-2 mt-6">
            <Button
              variant="outline"
              onClick={exportPdf}
              data-testid="button-export-pdf"
              disabled={isLocked}
              title={isLocked ? "Unlock the report to export" : undefined}
            >
              <Download className="w-4 h-4 mr-2" />
              Export to PDF
            </Button>
            <Button
              variant="outline"
              onClick={onShare}
              data-testid="button-share-report"
              disabled={isLocked}
              title={isLocked ? "Unlock the report to share" : undefined}
            >
              <Share2 className="w-4 h-4 mr-2" />
              Share report
            </Button>
          </div>
        </CardContent>
      </Card>
      <ShareModal
        open={shareOpen}
        onOpenChange={setShareOpen}
        analysis={analysis}
      />
      <BuyCreditsModal open={buyOpen} onOpenChange={setBuyOpen} />
    </div>
  );
}

function displayProvider(provider: string) {
  return provider === "MockInvokeLLM" ? "AI Career Impact Model" : provider;
}

function riskScoreColor(score: number) {
  const clamped = Math.max(0, Math.min(100, score));
  if (clamped <= 50) {
    const t = clamped / 50;
    const r = Math.round(52 + (250 - 52) * t);
    const g = Math.round(211 + (204 - 211) * t);
    const b = Math.round(153 + (21 - 153) * t);
    return `rgb(${r}, ${g}, ${b})`;
  }
  const t = (clamped - 50) / 50;
  const r = Math.round(250 + (239 - 250) * t);
  const g = Math.round(204 + (68 - 204) * t);
  const b = Math.round(21 + (68 - 21) * t);
  return `rgb(${r}, ${g}, ${b})`;
}

function concernEmoji(score: number) {
  const clamped = Math.max(0, Math.min(100, score));
  if (clamped < 20) return { emoji: "😀", label: "Low concern" };
  if (clamped < 40) return { emoji: "🙂", label: "Mild concern" };
  if (clamped < 60) return { emoji: "😐", label: "Moderate concern" };
  if (clamped < 80) return { emoji: "😟", label: "High concern" };
  return { emoji: "😰", label: "Very concerned" };
}

function RiskGauge({ risk, score }: { risk: string; score: number }) {
  const color = riskScoreColor(score);
  const concern = concernEmoji(score);
  const circumference = 2 * Math.PI * 32;
  const offset = circumference - (score / 100) * circumference;
  return (
    <div
      className="flex items-center gap-3"
      aria-label={`${risk} automation potential with concern score ${score} out of 100`}
      data-testid="gauge-risk-score"
    >
      <div className="grid place-items-center rounded-3xl border border-white/20 bg-white/10 w-28 h-28">
        <div className="text-center leading-none">
          <div className="text-5xl" aria-hidden="true">{concern.emoji}</div>
          <div className="mt-2 text-[16px] uppercase tracking-wider text-white/70">{concern.label}</div>
        </div>
      </div>
      <div className="relative w-20 h-20 shrink-0">
        <svg viewBox="0 0 80 80" className="-rotate-90 w-full h-full">
          <circle cx="40" cy="40" r="32" stroke="rgba(255,255,255,0.15)" strokeWidth="6" fill="none" />
          <circle
            cx="40"
            cy="40"
            r="32"
            stroke={color}
            strokeWidth="6"
            fill="none"
            strokeDasharray={circumference}
            strokeDashoffset={offset}
            strokeLinecap="round"
          />
        </svg>
        <div className="absolute inset-0 grid place-items-center text-white">
          <div className="text-center leading-none">
            <div className="text-base font-semibold tabular-nums">{score}</div>
            <div className="text-[9px] uppercase tracking-wider text-white/70">/100</div>
          </div>
        </div>
      </div>
    </div>
  );
}
