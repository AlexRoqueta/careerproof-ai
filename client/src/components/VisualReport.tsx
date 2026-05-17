import { useMemo } from "react";
import type { Analysis } from "@shared/schema";
import { Card } from "@/components/ui/card";
import {
  Sparkles,
  Target,
  Compass,
  ShieldCheck,
  Zap,
  Brain,
  AlertTriangle,
  TrendingUp,
  CheckCircle2,
  Lightbulb,
  Flag,
  Calendar,
} from "lucide-react";
import {
  parseReport,
  findSection,
  inferTaskWeight,
  type ParsedReport,
  type ReportSection,
  type ReportListItem,
} from "@/lib/reportSections";
import { toTitleCase } from "@/lib/format";

/* The visual report renders the parsed report markdown using the same
 * design language as the landing page (cyan/sky accents, dark navy
 * surfaces, gradient score tiles). Every section falls back to plain
 * prose if its structure isn't what we expect, so existing reports
 * keep working unchanged. */

interface Props {
  analysis: Analysis;
  /** Locked reports still get the header/score/section titles, but the
   * body is replaced by a blur overlay matching the landing-page
   * preview style. */
  locked?: boolean;
}

export function VisualReport({ analysis, locked = false }: Props) {
  const parsed = useMemo(() => parseReport(analysis.result_text), [analysis.result_text]);
  const tier = riskTier(analysis.risk_score);

  return (
    <div className="space-y-4" data-testid="view-visual-report">
      <ReportHero analysis={analysis} parsed={parsed} tier={tier} />

      <div className={locked ? "relative" : undefined}>
        {locked && <LockedOverlay />}
        <div
          className={`grid lg:grid-cols-12 gap-4 ${
            locked ? "pointer-events-none select-none" : ""
          }`}
          aria-hidden={locked || undefined}
        >
          <div className="lg:col-span-7 space-y-4">
            <CurrentImpactCard parsed={parsed} locked={locked} />
            <TaskExposureCard parsed={parsed} riskScore={analysis.risk_score} locked={locked} />
            <ActionPlanCard parsed={parsed} locked={locked} />
          </div>
          <div className="lg:col-span-5 space-y-4">
            <LeverageCard parsed={parsed} locked={locked} />
            <FirstWaveCard parsed={parsed} riskScore={analysis.risk_score} locked={locked} />
            <ResilienceCard parsed={parsed} locked={locked} />
            <BottomLineCard parsed={parsed} locked={locked} />
          </div>
        </div>
      </div>

      <FallbackSections parsed={parsed} locked={locked} />
      <ReportFooterNote />
    </div>
  );
}

/* ---------------- Hero / score ---------------- */

type RiskTier = {
  label: string;
  tone: "good" | "warn" | "bad";
  description: string;
};

function riskTier(score: number): RiskTier {
  const s = Math.max(0, Math.min(100, score));
  if (s < 35) {
    return {
      label: "Low exposure",
      tone: "good",
      description: "Your role's core work looks durable in the near term.",
    };
  }
  if (s < 55) {
    return {
      label: "Moderate exposure",
      tone: "warn",
      description: "Expect your role to evolve — tasks change before titles do.",
    };
  }
  if (s < 75) {
    return {
      label: "Moderate–High exposure",
      tone: "warn",
      description: "Real disruption likely in the next 3–5 years. Time to invest in the human edge.",
    };
  }
  return {
    label: "High exposure",
    tone: "bad",
    description: "Material parts of this role are squarely in AI's path. Move toward judgment-heavy work.",
  };
}

function toneTextClass(tone: "good" | "warn" | "bad") {
  return tone === "good"
    ? "text-emerald-300"
    : tone === "warn"
    ? "text-amber-300"
    : "text-rose-300";
}

function toneGradient(tone: "good" | "warn" | "bad") {
  return tone === "good"
    ? "from-emerald-300 to-teal-400"
    : tone === "warn"
    ? "from-amber-300 to-orange-400"
    : "from-rose-300 to-red-400";
}

function ReportHero({
  analysis,
  parsed,
  tier,
}: {
  analysis: Analysis;
  parsed: ParsedReport;
  tier: RiskTier;
}) {
  const title = toTitleCase(analysis.job_title);
  const provider = displayProvider(analysis.provider_used);
  return (
    <div className="relative" data-testid="report-hero">
      <div
        aria-hidden
        className="absolute -inset-px rounded-2xl bg-gradient-to-br from-cyan-400/30 via-sky-500/15 to-violet-500/30 blur-md"
      />
      <Card className="relative rounded-2xl border-border/60 bg-card/85 backdrop-blur p-5 sm:p-7 shadow-2xl overflow-hidden">
        <div aria-hidden className="absolute inset-0 grid-bg opacity-[0.08] pointer-events-none" />
        <div className="relative flex flex-col gap-6 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-xs uppercase tracking-[0.18em] text-cyan-300/90 font-semibold">
              <Brain className="h-3.5 w-3.5" /> AI Exposure Report
            </div>
            <h2
              className="mt-3 text-2xl sm:text-3xl font-semibold tracking-tight"
              data-testid="text-report-title"
            >
              {title}
            </h2>
            <p className="text-xs text-muted-foreground mt-1.5">
              Powered by {provider} · {parsed.sections.length > 0 ? "Structured analysis" : "AI assessment"}
            </p>

            <div className="mt-5 max-w-md">
              <div className="text-xs uppercase tracking-wider text-muted-foreground">
                Overall AI exposure
              </div>
              <div className="mt-1 flex items-end gap-2">
                <div className="text-5xl sm:text-6xl font-semibold tracking-tight tabular-nums">
                  <span
                    className={`bg-gradient-to-r ${toneGradient(tier.tone)} bg-clip-text text-transparent`}
                  >
                    {analysis.risk_score}
                  </span>
                </div>
                <div className="pb-2 text-base font-medium text-muted-foreground">/100</div>
              </div>
              <div className={`mt-1 text-sm font-medium ${toneTextClass(tier.tone)}`}>
                {tier.label} · {analysis.automation_risk} automation potential
              </div>
              <div className="mt-3 h-2 w-full rounded-full bg-muted overflow-hidden">
                <div
                  className="h-full rounded-full bg-gradient-to-r from-emerald-400 via-amber-400 to-rose-500 transition-[width] duration-700"
                  style={{ width: `${Math.max(4, Math.min(100, analysis.risk_score))}%` }}
                  aria-label={`Risk score ${analysis.risk_score} of 100`}
                  data-testid="bar-overall-risk"
                />
              </div>
              <p className="mt-3 text-sm text-muted-foreground leading-relaxed">{tier.description}</p>
            </div>
          </div>

          <div className="shrink-0 self-stretch sm:self-auto">
            <ScoreRing score={analysis.risk_score} tone={tier.tone} />
          </div>
        </div>

        <div className="relative mt-6 grid grid-cols-2 sm:grid-cols-4 gap-2.5">
          <MetricTile
            label="Automation risk"
            value={analysis.automation_risk}
            tone={
              analysis.automation_risk === "High"
                ? "bad"
                : analysis.automation_risk === "Low"
                ? "good"
                : "warn"
            }
            testId="tile-automation-risk"
          />
          <MetricTile
            label="Horizon"
            value="3–5 yrs"
            tone="warn"
            testId="tile-horizon"
          />
          <MetricTile
            label="Augmentation"
            value={tier.tone === "bad" ? "High" : "Strong"}
            tone="good"
            testId="tile-augmentation"
          />
          <MetricTile
            label="Human edge"
            value={tier.tone === "bad" ? "Critical" : "Compounding"}
            tone="good"
            testId="tile-human-edge"
          />
        </div>
      </Card>
    </div>
  );
}

function MetricTile({
  label,
  value,
  tone,
  testId,
}: {
  label: string;
  value: string;
  tone: "good" | "warn" | "bad";
  testId?: string;
}) {
  return (
    <div
      className="rounded-lg border border-border/60 bg-background/40 p-3"
      data-testid={testId}
    >
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className={`mt-1 text-sm font-semibold ${toneTextClass(tone)}`}>{value}</div>
    </div>
  );
}

function ScoreRing({ score, tone }: { score: number; tone: "good" | "warn" | "bad" }) {
  const clamped = Math.max(0, Math.min(100, score));
  const radius = 52;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (clamped / 100) * circumference;
  const stroke =
    tone === "good" ? "#34d399" : tone === "warn" ? "#fbbf24" : "#f43f5e";
  return (
    <div
      className="relative w-32 h-32 sm:w-36 sm:h-36 grid place-items-center"
      data-testid="ring-overall-score"
      aria-label={`AI exposure score ${clamped} of 100`}
    >
      <svg viewBox="0 0 140 140" className="-rotate-90 w-full h-full">
        <defs>
          <linearGradient id="ringGood" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="#6ee7b7" />
            <stop offset="100%" stopColor="#14b8a6" />
          </linearGradient>
          <linearGradient id="ringWarn" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="#fcd34d" />
            <stop offset="100%" stopColor="#fb923c" />
          </linearGradient>
          <linearGradient id="ringBad" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="#fda4af" />
            <stop offset="100%" stopColor="#e11d48" />
          </linearGradient>
        </defs>
        <circle
          cx="70"
          cy="70"
          r={radius}
          stroke="currentColor"
          className="text-muted-foreground/20"
          strokeWidth="10"
          fill="none"
        />
        <circle
          cx="70"
          cy="70"
          r={radius}
          stroke={`url(#${tone === "good" ? "ringGood" : tone === "warn" ? "ringWarn" : "ringBad"})`}
          strokeWidth="10"
          fill="none"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          strokeLinecap="round"
          style={{ transition: "stroke-dashoffset 0.8s ease-out" }}
        />
      </svg>
      <div className="absolute inset-0 grid place-items-center">
        <div className="text-center leading-none">
          <div className="text-3xl sm:text-4xl font-semibold tabular-nums" style={{ color: stroke }}>
            {clamped}
          </div>
          <div className="mt-1 text-[10px] uppercase tracking-wider text-muted-foreground">/100</div>
        </div>
      </div>
    </div>
  );
}

/* ---------------- Section cards ---------------- */

function SectionCard({
  title,
  icon,
  accent = "cyan",
  children,
  testId,
}: {
  title: string;
  icon: React.ReactNode;
  accent?: "cyan" | "violet" | "amber" | "emerald";
  children: React.ReactNode;
  testId?: string;
}) {
  const accentClass =
    accent === "violet"
      ? "from-violet-500/15 to-sky-500/10 text-violet-300 border-violet-400/20"
      : accent === "amber"
      ? "from-amber-500/15 to-orange-500/10 text-amber-300 border-amber-400/20"
      : accent === "emerald"
      ? "from-emerald-500/15 to-teal-500/10 text-emerald-300 border-emerald-400/20"
      : "from-cyan-500/15 to-sky-500/10 text-cyan-300 border-cyan-400/20";
  return (
    <Card
      className="border-border/60 bg-card/60 backdrop-blur p-5 sm:p-6 rounded-2xl"
      data-testid={testId}
    >
      <div className="flex items-center gap-2.5">
        <div
          className={`inline-flex items-center justify-center h-9 w-9 rounded-md bg-gradient-to-br ${accentClass} border`}
        >
          {icon}
        </div>
        <h3 className="font-semibold text-base sm:text-lg tracking-tight">{title}</h3>
      </div>
      <div className="mt-4">{children}</div>
    </Card>
  );
}

function paragraphsOrFallback(paragraphs: string[]) {
  if (!paragraphs.length) return null;
  return (
    <div className="space-y-2.5 text-sm leading-relaxed text-foreground/85">
      {paragraphs.map((p, i) => (
        <p key={i}>{p}</p>
      ))}
    </div>
  );
}

function CurrentImpactCard({ parsed, locked }: { parsed: ParsedReport; locked: boolean }) {
  const profession = findSection(parsed, "current_profession");
  const role = findSection(parsed, "current_role");
  if (!profession && !role) return null;
  return (
    <SectionCard
      title="Where AI already touches this work"
      icon={<Sparkles className="h-4 w-4" />}
      accent="cyan"
      testId="card-current-impact"
    >
      {locked ? (
        <LockedContent lines={4} />
      ) : (
        <div className="space-y-4">
          {profession && (
            <div>
              <div className="text-xs uppercase tracking-wider text-muted-foreground font-semibold">
                Across the profession
              </div>
              <div className="mt-2">{paragraphsOrFallback(profession.paragraphs)}</div>
            </div>
          )}
          {role && (
            <div>
              <div className="text-xs uppercase tracking-wider text-muted-foreground font-semibold">
                In your specific role
              </div>
              <div className="mt-2">{paragraphsOrFallback(role.paragraphs)}</div>
            </div>
          )}
        </div>
      )}
    </SectionCard>
  );
}

function TaskExposureCard({
  parsed,
  riskScore,
  locked,
}: {
  parsed: ParsedReport;
  riskScore: number;
  locked: boolean;
}) {
  const section = findSection(parsed, "task_decomposition");
  if (!section || section.items.length === 0) return null;
  return (
    <SectionCard
      title="Task exposure breakdown"
      icon={<Target className="h-4 w-4" />}
      accent="amber"
      testId="card-task-exposure"
    >
      {locked ? (
        <LockedContent lines={5} />
      ) : (
        <div className="space-y-3">
          {section.items.map((item, i) => {
            const heuristicText = `${item.title} ${item.body ?? ""}`;
            const { weight, tier } = inferTaskWeight(heuristicText, riskScore, i, section.items.length);
            return (
              <TaskExposureRow
                key={i}
                title={item.title}
                body={item.body}
                weight={weight}
                tier={tier}
              />
            );
          })}
          <p className="mt-3 text-[11px] text-muted-foreground italic leading-relaxed">
            Bars are directional indicators based on task patterns in the report. They show
            relative exposure, not precise percentages.
          </p>
        </div>
      )}
    </SectionCard>
  );
}

function TaskExposureRow({
  title,
  body,
  weight,
  tier,
}: {
  title: string;
  body?: string;
  weight: number;
  tier: "Low" | "Moderate" | "High";
}) {
  const toneClass =
    tier === "Low"
      ? "text-emerald-300 bg-emerald-500/10 border-emerald-500/30"
      : tier === "Moderate"
      ? "text-amber-300 bg-amber-500/10 border-amber-500/30"
      : "text-rose-300 bg-rose-500/10 border-rose-500/30";
  return (
    <div data-testid="row-task-exposure">
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
        <span className="font-medium">{title}</span>
        <span
          className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider ${toneClass}`}
        >
          {tier}
        </span>
      </div>
      {body && <div className="mt-1 text-xs text-muted-foreground">{body}</div>}
      <div className="mt-2 h-1.5 rounded-full bg-muted overflow-hidden">
        <div
          className="h-full rounded-full bg-gradient-to-r from-emerald-400 via-amber-400 to-rose-500"
          style={{ width: `${weight}%` }}
        />
      </div>
    </div>
  );
}

function FirstWaveCard({
  parsed,
  riskScore,
  locked,
}: {
  parsed: ParsedReport;
  riskScore: number;
  locked: boolean;
}) {
  const section = findSection(parsed, "where_ai_lands");
  if (!section || section.items.length === 0) return null;
  return (
    <SectionCard
      title="Where AI lands first"
      icon={<Zap className="h-4 w-4" />}
      accent="violet"
      testId="card-first-wave"
    >
      {locked ? (
        <LockedContent lines={4} />
      ) : (
        <div className="space-y-2.5">
          {section.items.map((item, i) => {
            const { weight } = inferTaskWeight(
              `${item.title} ${item.body ?? ""}`,
              Math.max(riskScore, 60),
              i,
              section.items.length,
            );
            return (
              <div
                key={i}
                className="rounded-lg border border-border/60 bg-background/40 p-3"
                data-testid="row-first-wave"
              >
                <div className="flex items-start gap-2">
                  <div className="mt-0.5 inline-flex h-5 w-5 items-center justify-center rounded-full bg-cyan-500/15 text-[11px] font-semibold text-cyan-300 border border-cyan-400/30">
                    {i + 1}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium">{item.title}</div>
                    {item.body && (
                      <div className="mt-1 text-xs text-muted-foreground">{item.body}</div>
                    )}
                    <div className="mt-2 h-1 rounded-full bg-muted overflow-hidden">
                      <div
                        className="h-full rounded-full bg-gradient-to-r from-cyan-400 to-violet-500"
                        style={{ width: `${weight}%` }}
                      />
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </SectionCard>
  );
}

function LeverageCard({ parsed, locked }: { parsed: ParsedReport; locked: boolean }) {
  const section = findSection(parsed, "leverage");
  if (!section || (section.items.length === 0 && section.paragraphs.length === 0)) return null;
  return (
    <SectionCard
      title="Your human edge"
      icon={<ShieldCheck className="h-4 w-4" />}
      accent="emerald"
      testId="card-leverage"
    >
      {locked ? (
        <LockedContent lines={4} />
      ) : (
        <div className="space-y-3">
          {paragraphsOrFallback(section.paragraphs)}
          {section.items.length > 0 && (
            <ul className="space-y-2">
              {section.items.map((item, i) => (
                <li
                  key={i}
                  className="rounded-md border border-emerald-500/20 bg-emerald-500/5 p-2.5 text-sm"
                  data-testid="row-leverage"
                >
                  <div className="flex items-start gap-2">
                    <CheckCircle2 className="mt-0.5 h-4 w-4 text-emerald-300 shrink-0" />
                    <div>
                      <span className="font-medium">{item.title}</span>
                      {item.body && (
                        <span className="text-muted-foreground"> — {item.body}</span>
                      )}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </SectionCard>
  );
}

function ActionPlanCard({ parsed, locked }: { parsed: ParsedReport; locked: boolean }) {
  const section = findSection(parsed, "action_90");
  if (!section || section.items.length === 0) return null;
  return (
    <SectionCard
      title="90-day action plan"
      icon={<Flag className="h-4 w-4" />}
      accent="cyan"
      testId="card-action-plan"
    >
      {locked ? (
        <LockedContent lines={5} />
      ) : (
        <ol className="relative space-y-3 pl-6 border-l border-cyan-400/20">
          {section.items.map((item, i) => (
            <li key={i} data-testid="row-action-step" className="relative">
              <span
                aria-hidden
                className="absolute -left-[31px] top-1 inline-flex h-6 w-6 items-center justify-center rounded-full bg-gradient-to-br from-cyan-400 to-sky-500 text-[11px] font-semibold text-slate-950 shadow-md shadow-cyan-500/30"
              >
                {i + 1}
              </span>
              <div className="rounded-lg border border-border/60 bg-background/40 p-3">
                <div className="text-sm font-medium">{item.title}</div>
                {item.body && (
                  <div className="mt-1 text-xs text-muted-foreground leading-relaxed">{item.body}</div>
                )}
              </div>
            </li>
          ))}
        </ol>
      )}
    </SectionCard>
  );
}

function ResilienceCard({ parsed, locked }: { parsed: ParsedReport; locked: boolean }) {
  const section = findSection(parsed, "resilience_12mo");
  if (!section || (section.items.length === 0 && section.paragraphs.length === 0)) return null;
  return (
    <SectionCard
      title="12-month resilience plan"
      icon={<Calendar className="h-4 w-4" />}
      accent="violet"
      testId="card-resilience-plan"
    >
      {locked ? (
        <LockedContent lines={4} />
      ) : (
        <div className="space-y-3">
          {paragraphsOrFallback(section.paragraphs)}
          {section.items.length > 0 && (
            <ul className="space-y-2">
              {section.items.map((item, i) => (
                <li
                  key={i}
                  className="rounded-md border border-border/60 bg-background/40 p-2.5 text-sm"
                  data-testid="row-resilience"
                >
                  <div className="flex items-start gap-2">
                    <Compass className="mt-0.5 h-4 w-4 text-cyan-300 shrink-0" />
                    <div>
                      <span className="font-medium">{item.title}</span>
                      {item.body && (
                        <span className="text-muted-foreground"> — {item.body}</span>
                      )}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </SectionCard>
  );
}

function BottomLineCard({ parsed, locked }: { parsed: ParsedReport; locked: boolean }) {
  const section = findSection(parsed, "bottom_line");
  if (!section || section.paragraphs.length === 0) return null;
  return (
    <SectionCard
      title="Bottom line"
      icon={<Lightbulb className="h-4 w-4" />}
      accent="amber"
      testId="card-bottom-line"
    >
      {locked ? (
        <LockedContent lines={3} />
      ) : (
        <div className="rounded-lg border border-amber-500/20 bg-amber-500/5 p-3.5 text-sm leading-relaxed">
          {section.paragraphs.map((p, i) => (
            <p key={i} className={i > 0 ? "mt-2" : undefined}>
              {p}
            </p>
          ))}
        </div>
      )}
    </SectionCard>
  );
}

/* Render any sections we didn't recognize so we never silently drop
 * content. Skips sections we already rendered as cards. */
function FallbackSections({ parsed, locked }: { parsed: ParsedReport; locked: boolean }) {
  const rendered = new Set([
    "overall",
    "current_profession",
    "current_role",
    "task_decomposition",
    "where_ai_lands",
    "leverage",
    "action_90",
    "resilience_12mo",
    "bottom_line",
  ]);
  const extras = parsed.sections.filter((s) => !rendered.has(s.kind));
  if (extras.length === 0 && parsed.intro.length === 0) return null;
  return (
    <>
      {parsed.intro.length > 0 && (
        <Card
          className="border-border/60 bg-card/40 backdrop-blur p-5 rounded-2xl"
          data-testid="card-intro"
        >
          {locked ? <LockedContent lines={3} /> : paragraphsOrFallback(parsed.intro)}
        </Card>
      )}
      {extras.map((s, i) => (
        <SectionCard
          key={i}
          title={s.heading}
          icon={<TrendingUp className="h-4 w-4" />}
          accent="cyan"
          testId="card-extra-section"
        >
          {locked ? (
            <LockedContent lines={3} />
          ) : (
            <div className="space-y-3">
              {paragraphsOrFallback(s.paragraphs)}
              {s.items.length > 0 && (
                <ul className="space-y-2">
                  {s.items.map((item, idx) => (
                    <li
                      key={idx}
                      className="rounded-md border border-border/60 bg-background/40 p-2.5 text-sm"
                    >
                      <span className="font-medium">{item.title}</span>
                      {item.body && (
                        <span className="text-muted-foreground"> — {item.body}</span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </SectionCard>
      ))}
    </>
  );
}

function ReportFooterNote() {
  return (
    <div className="rounded-lg border border-border/40 bg-background/40 p-3 text-[11px] text-muted-foreground leading-relaxed flex items-start gap-2">
      <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0 text-cyan-400" />
      <span>
        This assessment is informational and directional, not a guarantee. Labor markets are
        path-dependent and influenced by many factors outside any single role.
      </span>
    </div>
  );
}

function LockedOverlay() {
  return (
    <div
      className="absolute inset-0 z-10 grid place-items-center rounded-2xl pointer-events-none"
      data-testid="locked-overlay"
    >
      <div className="rounded-full border border-amber-500/30 bg-amber-500/10 px-3 py-1 text-xs font-medium text-amber-300 backdrop-blur">
        Body locked — unlock to read full analysis
      </div>
    </div>
  );
}

function LockedContent({ lines = 3 }: { lines?: number }) {
  return (
    <div className="space-y-2" aria-hidden>
      {Array.from({ length: lines }).map((_, i) => (
        <div
          key={i}
          className="h-3 rounded bg-muted"
          style={{ width: `${85 - i * 8}%`, filter: "blur(6px)" }}
        />
      ))}
    </div>
  );
}

function displayProvider(provider: string) {
  return provider === "MockInvokeLLM" ? "AI Career Impact Model" : provider;
}

export type { ReportListItem, ReportSection };
