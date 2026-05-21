import { useEffect } from "react";
import { useLocation } from "wouter";
import { Logo } from "@/components/Logo";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  ArrowRight,
  ArrowLeft,
  Sparkles,
  Compass,
  ShieldCheck,
  TrendingUp,
  AlertTriangle,
  CheckCircle2,
  Target,
  Brain,
  CalendarDays,
} from "lucide-react";
import { track, EVENTS } from "@/lib/analytics";

/**
 * Static sample CareerProof AI Exposure Report. Reachable at
 * `#/sample-report` without an account so prospective users can see
 * the actual report shape before signing up. No backend calls — all
 * content is hard-coded so the page costs nothing to serve.
 */
export default function SampleReport() {
  const [, setLocation] = useLocation();

  useEffect(() => {
    track(EVENTS.sample_report_viewed);
    window.scrollTo({ top: 0, behavior: "auto" });
  }, []);

  function goSignup(source: string) {
    track(EVENTS.landing_cta_click, { source: `sample_report_${source}` });
    // Route into the anonymous preview flow so visitors can generate a
    // free AI job-risk preview without creating an account first. Sign-up
    // is only requested when they want to save the preview or unlock the
    // full report.
    setLocation("/analyze");
    window.scrollTo({ top: 0, behavior: "auto" });
  }

  return (
    <div className="min-h-screen bg-background text-foreground antialiased">
      <BackgroundAurora />

      <header className="sticky top-0 z-40 backdrop-blur-md bg-background/80 border-b border-border/60">
        <div className="mx-auto max-w-6xl px-5 sm:px-8 h-16 flex items-center justify-between">
          <button
            onClick={() => setLocation("/")}
            className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors"
            data-testid="link-sample-back"
          >
            <ArrowLeft className="h-4 w-4" />
            <Logo />
          </button>
          <Button
            onClick={() => goSignup("header")}
            size="sm"
            className="bg-gradient-to-r from-cyan-400 to-sky-500 text-slate-950 hover:from-cyan-300 hover:to-sky-400 font-semibold shadow-lg shadow-sky-500/20"
            data-testid="button-sample-start"
          >
            Start my free preview
            <ArrowRight className="ml-1 h-4 w-4" />
          </Button>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-5 sm:px-8 py-10 sm:py-14 space-y-8">
        <div className="text-center max-w-3xl mx-auto">
          <div className="inline-flex items-center gap-2 rounded-full border border-cyan-400/30 bg-cyan-500/10 px-3 py-1 text-xs font-medium text-cyan-300">
            <Sparkles className="h-3.5 w-3.5" /> Sample CareerProof AI Exposure Report
          </div>
          <h1 className="mt-5 text-3xl sm:text-5xl font-semibold tracking-tight leading-tight">
            See exactly what you get back.
          </h1>
          <p className="mt-4 text-base sm:text-lg text-muted-foreground">
            This is a real, full-length sample report for a Senior Financial Analyst — built from
            static example data so you can scroll through every section before you sign up.
          </p>
          <p className="mt-3 text-sm text-muted-foreground">
            Your own free AI job-risk preview runs without an account. A free account is only
            required to upload a resume, import a LinkedIn profile, save your preview, or unlock
            the full AI Exposure Report ($3 — one credit).
          </p>
          <p className="mt-3 text-xs text-amber-300/90 inline-flex items-center gap-1.5">
            <AlertTriangle className="h-3.5 w-3.5" />
            Sample report. Directional career-risk insight, not a guarantee.
          </p>
        </div>

        <ReportHeader />
        <RiskScoreSection />
        <VulnerableTasksSection />
        <HumanAdvantageSection />
        <SkillsToBuildSection />
        <PlanSection />
        <DisclaimerCard />

        <FinalCTA onStart={() => goSignup("final_cta")} />

        <div className="text-center text-xs text-muted-foreground">
          No subscription required · One credit = one full report · Secure checkout powered by Stripe.
        </div>
      </main>
    </div>
  );
}

function BackgroundAurora() {
  return (
    <div aria-hidden className="pointer-events-none fixed inset-0 -z-10 overflow-hidden">
      <div
        className="absolute -top-40 -left-40 w-[36rem] h-[36rem] rounded-full blur-3xl opacity-25"
        style={{ background: "radial-gradient(closest-side, #22D3EE, transparent)" }}
      />
      <div
        className="absolute top-[20rem] right-[-10rem] w-[40rem] h-[40rem] rounded-full blur-3xl opacity-20"
        style={{ background: "radial-gradient(closest-side, #A78BFA, transparent)" }}
      />
    </div>
  );
}

function ReportHeader() {
  return (
    <Card className="border-border/60 bg-card/85 backdrop-blur p-6 sm:p-7">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="text-xs uppercase tracking-wider text-muted-foreground">Role analyzed</div>
          <div className="mt-1 text-xl sm:text-2xl font-semibold">Senior Financial Analyst</div>
          <div className="text-sm text-muted-foreground">
            Mid-market SaaS · 6+ years experience · United States
          </div>
        </div>
        <div className="text-[10px] font-medium uppercase tracking-wider text-cyan-300 px-2 py-0.5 rounded-full bg-cyan-500/10 border border-cyan-400/30">
          Sample
        </div>
      </div>
    </Card>
  );
}

function RiskScoreSection() {
  return (
    <section>
      <SectionHeader
        icon={<TrendingUp className="h-5 w-5" />}
        eyebrow="Section 1"
        title="AI risk score"
        description="Overall exposure across automation and AI augmentation, with a confidence band."
      />
      <div className="grid sm:grid-cols-3 gap-3">
        <ScoreTile label="Exposure" value="54" sub="/100" tone="warn" />
        <ScoreTile label="Task automation" value="48" sub="%" tone="warn" />
        <ScoreTile label="Human edge" value="High" tone="good" />
      </div>
      <Card className="mt-4 border-border/60 bg-card/70 p-4 sm:p-5">
        <div className="text-sm text-foreground/90">
          Your role sits in the <strong>moderate-exposure</strong> band. Substantial pieces of
          monthly close, variance commentary, and reconciliation work can already be drafted by
          modern AI tools. At the same time, the stakeholder-facing, judgment-heavy parts of the
          role — narrative for execs, capital-allocation tradeoffs, audit defense — remain
          well-protected for the foreseeable future.
        </div>
        <div className="mt-3 text-xs text-muted-foreground">
          Confidence: <span className="text-foreground/80">Medium-high</span> · Based on 240+ role
          signals and current AI capability benchmarks (Q1 2026).
        </div>
      </Card>
    </section>
  );
}

function VulnerableTasksSection() {
  const rows = [
    { label: "Variance commentary drafting", pct: 82, why: "Pattern-matching plus templated narrative — LLMs do this well." },
    { label: "Monthly close summarization", pct: 71, why: "Structured input, structured output. Easy to automate end-to-end." },
    { label: "Data reconciliation between systems", pct: 64, why: "Increasingly handled by AI-aware ETL + finance ops tools." },
    { label: "Ad-hoc reporting requests", pct: 58, why: "Natural-language → SQL → chart pipelines now production-ready." },
    { label: "Forecast model maintenance", pct: 45, why: "Copilots speed it up; full automation still needs human judgement." },
  ];
  return (
    <section>
      <SectionHeader
        icon={<AlertTriangle className="h-5 w-5" />}
        eyebrow="Section 2"
        title="Vulnerable tasks"
        description="Where AI tooling is already capable enough to absorb meaningful share of the work."
      />
      <Card className="border-border/60 bg-card/70 p-4 sm:p-5">
        <div className="space-y-4">
          {rows.map((r, i) => (
            <div key={i}>
              <div className="flex justify-between items-baseline text-sm">
                <span className="text-foreground/90 font-medium">{r.label}</span>
                <span className="text-muted-foreground tabular-nums">{r.pct}% automatable</span>
              </div>
              <div className="mt-1.5 h-1.5 rounded-full bg-muted overflow-hidden">
                <div
                  className="h-full rounded-full bg-gradient-to-r from-cyan-400 via-amber-400 to-rose-500"
                  style={{ width: `${r.pct}%` }}
                />
              </div>
              <div className="mt-1 text-xs text-muted-foreground">{r.why}</div>
            </div>
          ))}
        </div>
      </Card>
    </section>
  );
}

function HumanAdvantageSection() {
  const items = [
    {
      title: "Cross-functional storytelling",
      body: "Translating numbers into narrative for non-finance executives is still a high-trust, high-judgement task. AI can draft — humans land it.",
    },
    {
      title: "Capital-allocation judgement",
      body: "Choosing what to fund and what to kill requires political context, founder/CEO trust, and accountability AI doesn't carry.",
    },
    {
      title: "Audit & compliance defensibility",
      body: "Sign-off responsibility, regulator-facing decisions, and material-weakness risk keep humans in the loop.",
    },
    {
      title: "Deal & strategic-finance work",
      body: "M&A diligence, pricing strategy, and board-level scenarios reward pattern recognition only a senior human earns.",
    },
  ];
  return (
    <section>
      <SectionHeader
        icon={<ShieldCheck className="h-5 w-5" />}
        eyebrow="Section 3"
        title="Your human advantage"
        description="Areas where your judgement, relationships, and accountability stay durably valuable."
      />
      <div className="grid sm:grid-cols-2 gap-3">
        {items.map((it, i) => (
          <Card key={i} className="border-border/60 bg-card/70 p-4">
            <div className="flex items-start gap-3">
              <CheckCircle2 className="h-4 w-4 text-emerald-400 mt-1 shrink-0" />
              <div>
                <div className="font-semibold text-sm">{it.title}</div>
                <p className="mt-1 text-xs text-muted-foreground leading-relaxed">{it.body}</p>
              </div>
            </div>
          </Card>
        ))}
      </div>
    </section>
  );
}

function SkillsToBuildSection() {
  const skills = [
    {
      title: "AI-assisted scenario modeling",
      time: "Next 90 days",
      body: "Build fluency with Copilot for Excel, Hebbia, or Mosaic-style tools. Goal: 3x faster scenario decks with the same accuracy.",
    },
    {
      title: "Executive storytelling & narrative",
      time: "6–12 months",
      body: "Practice short, opinionated monthly memos for the leadership team. Move from \"reporter\" to \"interpreter\".",
    },
    {
      title: "Strategic finance / unit economics",
      time: "12 months",
      body: "Shift from controllership tasks into FP&A strategy — pricing, retention, contribution-margin economics.",
    },
    {
      title: "Data literacy for AI workflows",
      time: "Always-on",
      body: "Understand RAG, evals, and where LLMs are unreliable. Become the finance partner who can vet AI tooling.",
    },
  ];
  return (
    <section>
      <SectionHeader
        icon={<Brain className="h-5 w-5" />}
        eyebrow="Section 4"
        title="Skills to build"
        description="Concrete, role-specific bets ranked by ROI over the next 12 months."
      />
      <div className="grid sm:grid-cols-2 gap-3">
        {skills.map((s, i) => (
          <Card key={i} className="border-border/60 bg-card/70 p-4">
            <div className="flex items-center justify-between gap-2">
              <div className="font-semibold text-sm">{s.title}</div>
              <span className="text-[10px] uppercase tracking-wider text-cyan-300/90 border border-cyan-400/30 bg-cyan-500/10 rounded-full px-2 py-0.5">
                {s.time}
              </span>
            </div>
            <p className="mt-2 text-xs text-muted-foreground leading-relaxed">{s.body}</p>
          </Card>
        ))}
      </div>
    </section>
  );
}

function PlanSection() {
  const plan = [
    {
      window: "Next 30 days",
      icon: <Target className="h-4 w-4" />,
      items: [
        "Audit your top 5 recurring tasks against AI-automatable threshold — flag anything above 60%.",
        "Pick one AI tool (Copilot, Mosaic, Hebbia) and run a real workflow end-to-end this month.",
        "Draft a one-page \"AI fluency\" pitch for your manager: how you'll use, vet, and defend AI-assisted work.",
      ],
    },
    {
      window: "Next 60 days",
      icon: <Compass className="h-4 w-4" />,
      items: [
        "Replace one recurring report with an AI-assisted version — measure time-saved and accuracy.",
        "Volunteer for one cross-functional ask (pricing, retention deep-dive, GTM finance) outside core close work.",
        "Begin a short narrative-writing habit: one tight memo per month for the leadership team.",
      ],
    },
    {
      window: "Next 90 days",
      icon: <CalendarDays className="h-4 w-4" />,
      items: [
        "Position for a Strategic Finance / FP&A Lead title at next review — bring the narrative wins and AI-fluency case.",
        "Build one durable artifact (template, model, evaluation rubric) that the team adopts beyond you.",
        "Run a comparative AI Exposure Report on one adjacent role (RevOps, Strategic Finance) to inform next move.",
      ],
    },
  ];
  return (
    <section>
      <SectionHeader
        icon={<CalendarDays className="h-5 w-5" />}
        eyebrow="Section 5"
        title="Your 30 / 60 / 90-day plan"
        description="Concrete actions, in order, so you're moving — not panicking."
      />
      <div className="space-y-3">
        {plan.map((p, i) => (
          <Card key={i} className="border-border/60 bg-card/70 p-4 sm:p-5">
            <div className="flex items-center gap-2 text-sm font-semibold">
              <span className="inline-flex h-7 w-7 items-center justify-center rounded-md bg-cyan-500/10 border border-cyan-400/30 text-cyan-300">
                {p.icon}
              </span>
              {p.window}
            </div>
            <ul className="mt-3 space-y-2">
              {p.items.map((it, j) => (
                <li key={j} className="flex items-start gap-2 text-sm">
                  <CheckCircle2 className="mt-0.5 h-4 w-4 text-cyan-400 shrink-0" />
                  <span className="text-foreground/90">{it}</span>
                </li>
              ))}
            </ul>
          </Card>
        ))}
      </div>
    </section>
  );
}

function DisclaimerCard() {
  return (
    <Card className="border-amber-500/30 bg-amber-500/10 p-4 rounded-2xl">
      <div className="flex items-start gap-3">
        <AlertTriangle className="h-4 w-4 text-amber-300 shrink-0 mt-0.5" />
        <div className="text-xs text-amber-100/90 leading-relaxed">
          <strong>Sample report.</strong> Directional career-risk insight, not a guarantee. Your
          real report is generated against your actual role profile and current AI capability
          benchmarks — the structure stays the same, the content is yours.
        </div>
      </div>
    </Card>
  );
}

function FinalCTA({ onStart }: { onStart: () => void }) {
  return (
    <div className="relative rounded-2xl overflow-hidden border border-border/60 bg-gradient-to-br from-slate-900/80 to-slate-950/90 p-8 sm:p-10">
      <div
        aria-hidden
        className="absolute -inset-1 opacity-30 blur-2xl pointer-events-none"
        style={{
          background:
            "radial-gradient(40% 60% at 20% 30%, #22D3EE, transparent), radial-gradient(40% 60% at 80% 70%, #A78BFA, transparent)",
        }}
      />
      <div className="relative text-center">
        <h2 className="text-2xl sm:text-3xl font-semibold tracking-tight">
          Want one of these for{" "}
          <span className="bg-gradient-to-r from-cyan-300 to-sky-300 bg-clip-text text-transparent">
            your role?
          </span>
        </h2>
        <p className="mt-3 text-muted-foreground text-sm sm:text-base max-w-2xl mx-auto">
          Start the free AI job-risk preview without an account. Sign up only when you want to
          connect a resume or LinkedIn profile, save your preview, or unlock the full report.
          No subscription. One credit = one full AI Exposure Report.
        </p>
        <div className="mt-5 flex flex-col sm:flex-row items-center justify-center gap-3">
          <Button
            onClick={onStart}
            size="lg"
            className="h-12 px-7 text-base bg-gradient-to-r from-cyan-400 to-sky-500 text-slate-950 hover:from-cyan-300 hover:to-sky-400 font-semibold shadow-xl shadow-sky-500/30"
            data-testid="button-sample-final-cta"
          >
            Start my free preview
            <ArrowRight className="ml-2 h-4 w-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}

function SectionHeader({
  icon,
  eyebrow,
  title,
  description,
}: {
  icon: React.ReactNode;
  eyebrow: string;
  title: string;
  description: string;
}) {
  return (
    <div className="mb-4">
      <div className="flex items-center gap-2 text-xs uppercase tracking-[0.18em] text-cyan-300/90 font-semibold">
        <span className="inline-flex h-6 w-6 items-center justify-center rounded-md bg-cyan-500/10 border border-cyan-400/30 text-cyan-300">
          {icon}
        </span>
        {eyebrow}
      </div>
      <h2 className="mt-2 text-xl sm:text-2xl font-semibold tracking-tight">{title}</h2>
      <p className="mt-1 text-sm text-muted-foreground">{description}</p>
    </div>
  );
}

function ScoreTile({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub?: string;
  tone: "good" | "warn" | "bad";
}) {
  const grad =
    tone === "good"
      ? "from-emerald-300 to-teal-400"
      : tone === "warn"
      ? "from-amber-300 to-orange-400"
      : "from-rose-300 to-red-400";
  return (
    <Card className="border-border/60 bg-card/70 p-4">
      <div className="text-xs uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className="mt-1 text-3xl font-semibold">
        <span className={`bg-gradient-to-r ${grad} bg-clip-text text-transparent`}>{value}</span>
        {sub && <span className="text-sm text-muted-foreground ml-1">{sub}</span>}
      </div>
    </Card>
  );
}
