import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { motion } from "framer-motion";
import { Logo } from "@/components/Logo";
import { track, EVENTS } from "@/lib/analytics";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import {
  ArrowRight,
  ShieldCheck,
  Sparkles,
  Gauge,
  Brain,
  Briefcase,
  FileText,
  Linkedin,
  Type as TypeIcon,
  Lock,
  AlertTriangle,
  TrendingUp,
  CheckCircle2,
  Compass,
  Target,
  ChevronDown,
} from "lucide-react";

/**
 * Public marketing landing page shown to unauthenticated visitors.
 *
 * Primary CTA: "Check my AI job risk" → routes to SignIn screen (`#/signin`),
 * which handles both new-account creation and sign-in. Authenticated users
 * never see this page — the auth gate in App.tsx routes them straight to
 * the Analyze flow.
 */
export default function Landing() {
  const [, setLocation] = useLocation();

  useEffect(() => {
    track(EVENTS.landing_view);
  }, []);

  function goStart(source: string = "unknown") {
    track(EVENTS.landing_cta_click, { source });
    setLocation("/signin");
    // Scroll to top so the SignIn screen lands at the top of the viewport
    // on small screens where the landing page may have been scrolled deep.
    window.scrollTo({ top: 0, behavior: "auto" });
  }

  function goHow() {
    const el = document.getElementById("how-it-works");
    if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  return (
    <div className="min-h-screen bg-background text-foreground antialiased overflow-x-hidden">
      <BackgroundAurora />
      <NavBar onStart={() => goStart("nav")} />
      <Hero onStart={() => goStart("hero")} onHow={goHow} />
      <ProblemSection />
      <HowItWorks />
      <Benefits />
      <InputMethods />
      <SampleReport />
      <TrustSafety />
      <FAQSection />
      <FinalCTA onStart={() => goStart("final_cta")} />
      <Footer />
    </div>
  );
}

/* ---------------- Background ---------------- */

function BackgroundAurora() {
  return (
    <div aria-hidden className="pointer-events-none fixed inset-0 -z-10 overflow-hidden">
      <div className="absolute -top-40 -left-40 w-[36rem] h-[36rem] rounded-full blur-3xl opacity-30"
        style={{ background: "radial-gradient(closest-side, #22D3EE, transparent)" }} />
      <div className="absolute -top-20 right-[-10rem] w-[40rem] h-[40rem] rounded-full blur-3xl opacity-25"
        style={{ background: "radial-gradient(closest-side, #38BDF8, transparent)" }} />
      <div className="absolute top-[40rem] left-[-10rem] w-[34rem] h-[34rem] rounded-full blur-3xl opacity-20"
        style={{ background: "radial-gradient(closest-side, #A78BFA, transparent)" }} />
      <div className="absolute inset-0 opacity-[0.08]"
        style={{
          backgroundImage:
            "linear-gradient(rgba(255,255,255,.5) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,.5) 1px, transparent 1px)",
          backgroundSize: "44px 44px",
          maskImage: "radial-gradient(ellipse at top, rgba(0,0,0,.65), transparent 70%)",
          WebkitMaskImage: "radial-gradient(ellipse at top, rgba(0,0,0,.65), transparent 70%)",
        }}
      />
    </div>
  );
}

/* ---------------- Nav ---------------- */

function NavBar({ onStart }: { onStart: () => void }) {
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 6);
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);
  return (
    <header
      className={`sticky top-0 z-40 transition-all ${
        scrolled
          ? "backdrop-blur-md bg-background/70 border-b border-border/60"
          : "bg-transparent"
      }`}
    >
      <div className="mx-auto max-w-6xl px-5 sm:px-8 h-16 flex items-center justify-between">
        <Logo />
        <nav className="hidden md:flex items-center gap-7 text-sm text-muted-foreground">
          <a href="#how-it-works" className="hover:text-foreground transition-colors">How it works</a>
          <a href="#benefits" className="hover:text-foreground transition-colors">Benefits</a>
          <a href="#sample" className="hover:text-foreground transition-colors">Sample report</a>
          <a href="#faq" className="hover:text-foreground transition-colors">FAQ</a>
        </nav>
        <Button
          onClick={onStart}
          size="sm"
          className="bg-gradient-to-r from-cyan-400 to-sky-500 text-slate-950 hover:from-cyan-300 hover:to-sky-400 font-semibold shadow-lg shadow-sky-500/20"
          data-testid="button-nav-start"
        >
          Start free <ArrowRight className="ml-1 h-4 w-4" />
        </Button>
      </div>
    </header>
  );
}

/* ---------------- Hero ---------------- */

function Hero({ onStart, onHow }: { onStart: () => void; onHow: () => void }) {
  return (
    <section className="relative pt-12 sm:pt-20 pb-16 sm:pb-24">
      <div className="mx-auto max-w-6xl px-5 sm:px-8 grid lg:grid-cols-12 gap-10 items-center">
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, ease: "easeOut" }}
          className="lg:col-span-7"
        >
          <div className="inline-flex items-center gap-2 rounded-full border border-cyan-400/30 bg-cyan-500/10 px-3 py-1 text-xs font-medium text-cyan-300">
            <Sparkles className="h-3.5 w-3.5" /> Career-risk intelligence, powered by AI
          </div>
          <h1 className="mt-5 text-4xl sm:text-5xl md:text-6xl font-semibold tracking-tight leading-[1.05]">
            Is AI coming{" "}
            <span className="bg-gradient-to-r from-cyan-300 via-sky-300 to-violet-300 bg-clip-text text-transparent">
              for your job?
            </span>
          </h1>
          <p className="mt-5 text-lg sm:text-xl text-muted-foreground max-w-2xl leading-relaxed">
            Check your AI job risk before your role changes. Get a clear, data-informed read on
            how exposed your current or prospective role may be to AI disruption — and the skills
            and moves that protect your career.
          </p>
          <div className="mt-6 inline-flex items-start gap-2.5 rounded-xl border border-cyan-400/30 bg-gradient-to-r from-cyan-500/10 via-sky-500/10 to-violet-500/10 px-4 py-2.5 max-w-2xl">
            <Sparkles className="mt-0.5 h-4 w-4 text-cyan-300 shrink-0" />
            <p className="text-sm sm:text-[0.95rem] font-medium text-foreground/90 leading-snug">
              For less than a latte, get a full AI job-risk report and a plan to stay ahead.
            </p>
          </div>
          <div className="mt-6 flex flex-col sm:flex-row items-stretch sm:items-center gap-3">
            <Button
              onClick={onStart}
              size="lg"
              className="h-12 px-7 text-base bg-gradient-to-r from-cyan-400 to-sky-500 text-slate-950 hover:from-cyan-300 hover:to-sky-400 font-semibold shadow-xl shadow-sky-500/30"
              data-testid="button-hero-start"
            >
              Check my AI job risk <ArrowRight className="ml-2 h-4 w-4" />
            </Button>
            <Button
              onClick={onHow}
              size="lg"
              variant="outline"
              className="h-12 px-6 text-base border-border/70 hover:bg-card/60"
              data-testid="button-hero-how"
            >
              See how it works
            </Button>
          </div>
          <div className="mt-6 flex flex-wrap items-center gap-x-6 gap-y-2 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1.5"><ShieldCheck className="h-4 w-4 text-cyan-400" /> Private — your data is yours</span>
            <span className="inline-flex items-center gap-1.5"><Gauge className="h-4 w-4 text-cyan-400" /> Results in under a minute</span>
            <span className="inline-flex items-center gap-1.5"><Sparkles className="h-4 w-4 text-cyan-400" /> No credit card to start</span>
          </div>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 24 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.7, ease: "easeOut", delay: 0.1 }}
          className="lg:col-span-5"
        >
          <HeroRiskCard />
        </motion.div>
      </div>
    </section>
  );
}

function HeroRiskCard() {
  return (
    <div className="relative">
      <div className="absolute -inset-px rounded-2xl bg-gradient-to-br from-cyan-400/40 via-sky-500/20 to-violet-500/30 blur-md" aria-hidden />
      <Card className="relative rounded-2xl border-border/60 bg-card/80 backdrop-blur p-5 sm:p-6 shadow-2xl">
        <div className="flex items-center justify-between">
          <div className="text-xs font-medium uppercase tracking-wider text-muted-foreground">AI Exposure Report</div>
          <div className="text-[10px] font-medium uppercase tracking-wider text-cyan-300/90 px-2 py-0.5 rounded-full bg-cyan-500/10 border border-cyan-400/30">Sample</div>
        </div>
        <div className="mt-3 text-lg sm:text-xl font-semibold">Marketing Coordinator</div>
        <div className="text-xs text-muted-foreground">SaaS · 3–5 yrs experience</div>

        <div className="mt-5">
          <div className="flex items-end justify-between">
            <div>
              <div className="text-xs uppercase tracking-wider text-muted-foreground">Overall risk</div>
              <div className="mt-1 text-4xl sm:text-5xl font-semibold tracking-tight">
                <span className="bg-gradient-to-r from-amber-300 to-orange-400 bg-clip-text text-transparent">68</span>
                <span className="text-base font-medium text-muted-foreground ml-1">/100</span>
              </div>
              <div className="mt-1 text-sm font-medium text-amber-300">Moderate–High exposure</div>
            </div>
            <div className="text-right text-xs text-muted-foreground">
              <div>5-year horizon</div>
              <div className="mt-1">Updated weekly</div>
            </div>
          </div>
          <div className="mt-4 h-2 w-full rounded-full bg-muted overflow-hidden">
            <div className="h-full rounded-full bg-gradient-to-r from-emerald-400 via-amber-400 to-rose-500" style={{ width: "68%" }} />
          </div>
        </div>

        <div className="mt-5 grid grid-cols-2 gap-2.5">
          <MiniMetric label="Automatable tasks" value="62%" tone="warn" />
          <MiniMetric label="AI-leverageable" value="High" tone="good" />
          <MiniMetric label="Human edge" value="Strategy" tone="good" />
          <MiniMetric label="Job market" value="Shifting" tone="warn" />
        </div>

        <div className="mt-5 rounded-lg border border-border/60 bg-background/40 p-3">
          <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Top skill to build</div>
          <div className="mt-1 text-sm font-medium flex items-center gap-2">
            <Target className="h-4 w-4 text-cyan-400" /> Lifecycle marketing analytics &amp; AI tooling
          </div>
        </div>
      </Card>
    </div>
  );
}

function MiniMetric({ label, value, tone }: { label: string; value: string; tone: "good" | "warn" | "bad" }) {
  const toneClass =
    tone === "good"
      ? "text-emerald-300"
      : tone === "warn"
      ? "text-amber-300"
      : "text-rose-300";
  return (
    <div className="rounded-lg border border-border/60 bg-background/40 p-3">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className={`mt-1 text-sm font-semibold ${toneClass}`}>{value}</div>
    </div>
  );
}

/* ---------------- Problem ---------------- */

function ProblemSection() {
  const items = [
    {
      icon: <AlertTriangle className="h-5 w-5" />,
      title: "AI is reshaping roles, not just tasks",
      body: "Entire workflows — from drafting to analysis to triage — are being absorbed by AI tools at a pace most career playbooks weren't built for.",
    },
    {
      icon: <TrendingUp className="h-5 w-5" />,
      title: "Quiet displacement is hard to spot",
      body: "Companies rarely announce 'we replaced these tasks with AI.' Hiring freezes, scope shrinkage, and shifted job descriptions often happen first.",
    },
    {
      icon: <Compass className="h-5 w-5" />,
      title: "Generic advice won't help",
      body: "Your exposure depends on your specific role, industry, seniority, and skill mix — not on a viral list of 'safe jobs.'",
    },
  ];
  return (
    <section className="py-16 sm:py-24 border-t border-border/40">
      <div className="mx-auto max-w-6xl px-5 sm:px-8">
        <div className="max-w-2xl">
          <div className="text-xs uppercase tracking-[0.18em] text-cyan-300/90 font-semibold">The shift is already underway</div>
          <h2 className="mt-3 text-3xl sm:text-4xl font-semibold tracking-tight">
            Most people will find out their role changed{" "}
            <span className="text-foreground/70">after</span> the decisions are made.
          </h2>
          <p className="mt-4 text-muted-foreground text-lg leading-relaxed">
            CareerProof AI gives you a head start: a clear, role-specific signal on where AI is most
            likely to reshape your work, and where your human edge still compounds.
          </p>
        </div>
        <div className="mt-10 grid md:grid-cols-3 gap-4">
          {items.map((it, i) => (
            <motion.div
              key={i}
              initial={{ opacity: 0, y: 16 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, margin: "-60px" }}
              transition={{ duration: 0.5, delay: i * 0.08 }}
            >
              <Card className="h-full border-border/60 bg-card/60 backdrop-blur p-5">
                <div className="inline-flex items-center justify-center h-9 w-9 rounded-md bg-cyan-500/10 text-cyan-300 border border-cyan-400/20">
                  {it.icon}
                </div>
                <div className="mt-3 font-semibold">{it.title}</div>
                <p className="mt-2 text-sm text-muted-foreground leading-relaxed">{it.body}</p>
              </Card>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ---------------- How it works ---------------- */

function HowItWorks() {
  const steps = [
    {
      n: "01",
      title: "Tell us your role",
      body: "Paste a job title, upload a resume, or import your LinkedIn profile. Takes seconds.",
      icon: <Briefcase className="h-5 w-5" />,
    },
    {
      n: "02",
      title: "We analyze with AI",
      body: "We map your responsibilities, skills, and seniority against current AI capabilities and labor-market signals.",
      icon: <Brain className="h-5 w-5" />,
    },
    {
      n: "03",
      title: "Get your risk report",
      body: "See exposure scores, what's most automatable, where your human edge sits, and the skills worth investing in next.",
      icon: <ShieldCheck className="h-5 w-5" />,
    },
  ];
  return (
    <section id="how-it-works" className="py-16 sm:py-24 border-t border-border/40">
      <div className="mx-auto max-w-6xl px-5 sm:px-8">
        <div className="max-w-2xl">
          <div className="text-xs uppercase tracking-[0.18em] text-cyan-300/90 font-semibold">How it works</div>
          <h2 className="mt-3 text-3xl sm:text-4xl font-semibold tracking-tight">
            From job title to risk report in under a minute.
          </h2>
        </div>
        <div className="mt-10 grid md:grid-cols-3 gap-4 relative">
          {steps.map((s, i) => (
            <motion.div
              key={s.n}
              initial={{ opacity: 0, y: 16 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, margin: "-60px" }}
              transition={{ duration: 0.5, delay: i * 0.1 }}
            >
              <Card className="h-full border-border/60 bg-card/60 backdrop-blur p-6 relative">
                <div className="text-xs font-mono text-cyan-300/80">{s.n}</div>
                <div className="mt-3 inline-flex items-center justify-center h-10 w-10 rounded-md bg-gradient-to-br from-cyan-500/20 to-sky-500/10 text-cyan-300 border border-cyan-400/20">
                  {s.icon}
                </div>
                <div className="mt-4 text-lg font-semibold">{s.title}</div>
                <p className="mt-2 text-sm text-muted-foreground leading-relaxed">{s.body}</p>
              </Card>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ---------------- Benefits ---------------- */

function Benefits() {
  const items = [
    {
      icon: <Gauge className="h-5 w-5" />,
      title: "Objective risk score",
      body: "A clear 0–100 exposure read, broken down across task automation, AI augmentation, and labor-market shifts.",
    },
    {
      icon: <Target className="h-5 w-5" />,
      title: "Skills that pay off",
      body: "Personalized recommendations for what to learn next — weighted by your role, level, and current strengths.",
    },
    {
      icon: <Compass className="h-5 w-5" />,
      title: "Strategic career moves",
      body: "Adjacent roles, specialization paths, and pivots where your existing experience compounds instead of resets.",
    },
    {
      icon: <ShieldCheck className="h-5 w-5" />,
      title: "Your human edge, mapped",
      body: "Surface the judgment, relationships, and domain expertise AI is least likely to replicate in your field.",
    },
    {
      icon: <TrendingUp className="h-5 w-5" />,
      title: "Forward-looking signals",
      body: "Reports factor in where AI capabilities and hiring trends are heading — not just where they are today.",
    },
    {
      icon: <FileText className="h-5 w-5" />,
      title: "Shareable, saved reports",
      body: "Keep a history, compare roles, and share your report with a mentor, manager, or career coach.",
    },
  ];
  return (
    <section id="benefits" className="py-16 sm:py-24 border-t border-border/40">
      <div className="mx-auto max-w-6xl px-5 sm:px-8">
        <div className="max-w-2xl">
          <div className="text-xs uppercase tracking-[0.18em] text-cyan-300/90 font-semibold">Why CareerProof AI</div>
          <h2 className="mt-3 text-3xl sm:text-4xl font-semibold tracking-tight">
            A career-risk read that's actually useful.
          </h2>
          <p className="mt-4 text-muted-foreground text-lg leading-relaxed">
            Not a generic “these jobs are safe” list. A specific, role-aware view of where you may
            be vulnerable — and what to do about it.
          </p>
        </div>
        <div className="mt-10 grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {items.map((it, i) => (
            <motion.div
              key={i}
              initial={{ opacity: 0, y: 14 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, margin: "-60px" }}
              transition={{ duration: 0.45, delay: (i % 3) * 0.08 }}
            >
              <Card className="h-full border-border/60 bg-card/60 backdrop-blur p-5">
                <div className="inline-flex items-center justify-center h-9 w-9 rounded-md bg-gradient-to-br from-cyan-500/15 to-violet-500/10 text-cyan-300 border border-cyan-400/20">
                  {it.icon}
                </div>
                <div className="mt-3 font-semibold">{it.title}</div>
                <p className="mt-2 text-sm text-muted-foreground leading-relaxed">{it.body}</p>
              </Card>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ---------------- Input methods ---------------- */

function InputMethods() {
  const methods = [
    {
      icon: <TypeIcon className="h-5 w-5" />,
      title: "Type a job title",
      body: "Just start with your role. AI fills the rest — responsibilities, common skills, seniority context.",
      badge: "Fastest",
    },
    {
      icon: <FileText className="h-5 w-5" />,
      title: "Upload a resume",
      body: "Drop in a DOCX or PDF. We pull out your real experience for a more accurate read.",
      badge: "PDF · DOCX",
    },
    {
      icon: <Linkedin className="h-5 w-5" />,
      title: "Import from LinkedIn",
      body: "Paste your LinkedIn profile and we'll clean it up automatically — no scraping, no creds.",
      badge: "Recommended",
    },
    {
      icon: <Briefcase className="h-5 w-5" />,
      title: "Or roll your own",
      body: "Manually describe your role, responsibilities, and skills if you'd rather start from scratch.",
      badge: "Flexible",
    },
  ];
  return (
    <section className="py-16 sm:py-24 border-t border-border/40">
      <div className="mx-auto max-w-6xl px-5 sm:px-8">
        <div className="max-w-2xl">
          <div className="text-xs uppercase tracking-[0.18em] text-cyan-300/90 font-semibold">Four ways to start</div>
          <h2 className="mt-3 text-3xl sm:text-4xl font-semibold tracking-tight">
            Begin in whatever way is fastest for you.
          </h2>
        </div>
        <div className="mt-10 grid sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {methods.map((m, i) => (
            <motion.div
              key={i}
              initial={{ opacity: 0, y: 14 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, margin: "-60px" }}
              transition={{ duration: 0.45, delay: i * 0.06 }}
            >
              <Card className="h-full border-border/60 bg-card/60 backdrop-blur p-5">
                <div className="flex items-center justify-between">
                  <div className="inline-flex items-center justify-center h-9 w-9 rounded-md bg-cyan-500/10 text-cyan-300 border border-cyan-400/20">
                    {m.icon}
                  </div>
                  <span className="text-[10px] uppercase tracking-wider font-semibold text-cyan-300/90 px-2 py-0.5 rounded-full bg-cyan-500/10 border border-cyan-400/30">
                    {m.badge}
                  </span>
                </div>
                <div className="mt-4 font-semibold">{m.title}</div>
                <p className="mt-2 text-sm text-muted-foreground leading-relaxed">{m.body}</p>
              </Card>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ---------------- Sample Report ---------------- */

function SampleReport() {
  return (
    <section id="sample" className="py-16 sm:py-24 border-t border-border/40">
      <div className="mx-auto max-w-6xl px-5 sm:px-8 grid lg:grid-cols-12 gap-10 items-center">
        <div className="lg:col-span-5">
          <div className="text-xs uppercase tracking-[0.18em] text-cyan-300/90 font-semibold">Sample report</div>
          <h2 className="mt-3 text-3xl sm:text-4xl font-semibold tracking-tight">
            What you actually get back.
          </h2>
          <p className="mt-4 text-muted-foreground text-lg leading-relaxed">
            A practical, role-specific brief. Not a list of buzzwords. Every report is anchored to
            your inputs, with clear signals you can act on this quarter.
          </p>
          <ul className="mt-6 space-y-3">
            {[
              "Overall AI-exposure score with confidence band",
              "Task-level breakdown: automatable vs. AI-augmentable",
              "Top 3 skills worth building over the next 12 months",
              "Adjacent roles where your experience compounds",
              "Risk caveats specific to your industry and seniority",
            ].map((line, i) => (
              <li key={i} className="flex items-start gap-2.5 text-sm">
                <CheckCircle2 className="mt-0.5 h-4 w-4 text-cyan-400 shrink-0" />
                <span className="text-foreground/90">{line}</span>
              </li>
            ))}
          </ul>
          <div className="mt-6">
            <a
              href="#/sample-report"
              onClick={() => track(EVENTS.landing_cta_click, { source: "sample_report_link" })}
              className="inline-flex items-center gap-2 rounded-md border border-cyan-400/40 bg-cyan-500/10 px-4 py-2 text-sm font-medium text-cyan-200 hover:bg-cyan-500/15 transition-colors"
              data-testid="link-sample-report"
            >
              See a sample AI Exposure Report
              <ArrowRight className="h-4 w-4" />
            </a>
            <p className="mt-2 text-xs text-muted-foreground">
              Sample report. Directional career-risk insight, not a guarantee.
            </p>
          </div>
        </div>
        <div className="lg:col-span-7">
          <SampleReportCard />
        </div>
      </div>
    </section>
  );
}

function SampleReportCard() {
  return (
    <div className="relative">
      <div className="absolute -inset-px rounded-2xl bg-gradient-to-br from-cyan-400/30 via-violet-500/20 to-sky-400/30 blur-md" aria-hidden />
      <Card className="relative rounded-2xl border-border/60 bg-card/85 backdrop-blur p-5 sm:p-7 shadow-2xl">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div>
            <div className="text-xs uppercase tracking-wider text-muted-foreground">Role analyzed</div>
            <div className="mt-1 text-lg sm:text-xl font-semibold">Senior Financial Analyst</div>
            <div className="text-xs text-muted-foreground">Mid-market SaaS · 6+ yrs experience</div>
          </div>
          <div className="text-[10px] font-medium uppercase tracking-wider text-cyan-300/90 px-2 py-0.5 rounded-full bg-cyan-500/10 border border-cyan-400/30">Sample</div>
        </div>

        <div className="mt-6 grid sm:grid-cols-3 gap-3">
          <ScoreTile label="Exposure" value="54" sub="/100" tone="warn" />
          <ScoreTile label="Task automation" value="48" sub="%" tone="warn" />
          <ScoreTile label="Human edge" value="High" tone="good" />
        </div>

        <div className="mt-6 rounded-xl border border-border/60 bg-background/40 p-4">
          <div className="text-xs uppercase tracking-wider font-semibold text-muted-foreground">Most automatable tasks</div>
          <div className="mt-3 space-y-2.5">
            <RiskRow label="Variance commentary drafting" pct={82} />
            <RiskRow label="Monthly close summarization" pct={71} />
            <RiskRow label="Data reconciliation" pct={64} />
            <RiskRow label="Forecast model maintenance" pct={45} />
          </div>
        </div>

        <div className="mt-4 grid sm:grid-cols-2 gap-3">
          <div className="rounded-xl border border-border/60 bg-background/40 p-4">
            <div className="text-xs uppercase tracking-wider font-semibold text-muted-foreground">Top skills to build</div>
            <ul className="mt-2 space-y-1.5 text-sm">
              <li className="flex items-center gap-2"><Sparkles className="h-3.5 w-3.5 text-cyan-400" /> Scenario modeling with AI copilots</li>
              <li className="flex items-center gap-2"><Sparkles className="h-3.5 w-3.5 text-cyan-400" /> Storytelling for non-finance execs</li>
              <li className="flex items-center gap-2"><Sparkles className="h-3.5 w-3.5 text-cyan-400" /> Strategic finance / unit economics</li>
            </ul>
          </div>
          <div className="rounded-xl border border-border/60 bg-background/40 p-4">
            <div className="text-xs uppercase tracking-wider font-semibold text-muted-foreground">Adjacent moves</div>
            <ul className="mt-2 space-y-1.5 text-sm">
              <li className="flex items-center gap-2"><Compass className="h-3.5 w-3.5 text-cyan-400" /> Strategic Finance / FP&amp;A Lead</li>
              <li className="flex items-center gap-2"><Compass className="h-3.5 w-3.5 text-cyan-400" /> Revenue Operations Analyst</li>
              <li className="flex items-center gap-2"><Compass className="h-3.5 w-3.5 text-cyan-400" /> Finance Business Partner</li>
            </ul>
          </div>
        </div>
      </Card>
    </div>
  );
}

function ScoreTile({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone: "good" | "warn" | "bad" }) {
  const grad =
    tone === "good"
      ? "from-emerald-300 to-teal-400"
      : tone === "warn"
      ? "from-amber-300 to-orange-400"
      : "from-rose-300 to-red-400";
  return (
    <div className="rounded-xl border border-border/60 bg-background/40 p-4">
      <div className="text-xs uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className="mt-1 text-2xl sm:text-3xl font-semibold">
        <span className={`bg-gradient-to-r ${grad} bg-clip-text text-transparent`}>{value}</span>
        {sub && <span className="text-sm text-muted-foreground ml-1">{sub}</span>}
      </div>
    </div>
  );
}

function RiskRow({ label, pct }: { label: string; pct: number }) {
  return (
    <div>
      <div className="flex justify-between items-center text-sm">
        <span>{label}</span>
        <span className="text-muted-foreground tabular-nums">{pct}%</span>
      </div>
      <div className="mt-1 h-1.5 rounded-full bg-muted overflow-hidden">
        <div
          className="h-full rounded-full bg-gradient-to-r from-cyan-400 via-amber-400 to-rose-500"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

/* ---------------- Trust & Safety ---------------- */

function TrustSafety() {
  const items = [
    {
      icon: <Lock className="h-5 w-5" />,
      title: "Your data stays yours",
      body: "We use your inputs to generate your report. We don't sell them and we don't train public models on your private resume or LinkedIn data.",
    },
    {
      icon: <ShieldCheck className="h-5 w-5" />,
      title: "Signal, not certainty",
      body: "AI risk forecasts are estimates, not guarantees. We're transparent about what the model knows, what it doesn't, and the confidence behind each score.",
    },
    {
      icon: <Sparkles className="h-5 w-5" />,
      title: "Designed to be actionable",
      body: "Every section is paired with what to do next. The goal isn't to alarm you — it's to give you a head start.",
    },
  ];
  return (
    <section className="py-16 sm:py-24 border-t border-border/40">
      <div className="mx-auto max-w-6xl px-5 sm:px-8">
        <div className="max-w-2xl">
          <div className="text-xs uppercase tracking-[0.18em] text-cyan-300/90 font-semibold">Trust &amp; safety</div>
          <h2 className="mt-3 text-3xl sm:text-4xl font-semibold tracking-tight">
            Honest about what we know — and what we don't.
          </h2>
        </div>
        <div className="mt-10 grid md:grid-cols-3 gap-4">
          {items.map((it, i) => (
            <Card key={i} className="h-full border-border/60 bg-card/60 backdrop-blur p-5">
              <div className="inline-flex items-center justify-center h-9 w-9 rounded-md bg-cyan-500/10 text-cyan-300 border border-cyan-400/20">
                {it.icon}
              </div>
              <div className="mt-3 font-semibold">{it.title}</div>
              <p className="mt-2 text-sm text-muted-foreground leading-relaxed">{it.body}</p>
            </Card>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ---------------- FAQ ---------------- */

function FAQSection() {
  const faqs = [
    {
      q: "What exactly does the report tell me?",
      a: "Your overall AI-exposure score, a task-level breakdown of what's most automatable in your role, the skills worth building next, adjacent roles where your experience compounds, and caveats specific to your industry and seniority.",
    },
    {
      q: "Is this fortune-telling? How accurate is it?",
      a: "No. It's a structured read of current AI capabilities, labor-market signals, and your role profile. We're explicit that it's a directional signal, not a guarantee — and we surface confidence levels with each score.",
    },
    {
      q: "Will my resume or LinkedIn data be used to train AI?",
      a: "No. We use your inputs to generate your personal report. We don't sell your data and we don't use it to train public models.",
    },
    {
      q: "Do I need to pay to try it?",
      a: "No. You can run an analysis without entering a credit card. Additional reports and deeper analyses are available with credits.",
    },
    {
      q: "Can I analyze a role I'm thinking about taking?",
      a: "Yes. CareerProof works just as well for prospective roles — paste the job title or description and we'll generate the same risk-and-opportunity read.",
    },
    {
      q: "What if my role is already AI-resistant?",
      a: "Great — the report will tell you. You'll also see which adjacent capabilities compound on your existing strengths and where the next wave of AI may eventually reach.",
    },
  ];
  return (
    <section id="faq" className="py-16 sm:py-24 border-t border-border/40">
      <div className="mx-auto max-w-3xl px-5 sm:px-8">
        <div className="text-center">
          <div className="text-xs uppercase tracking-[0.18em] text-cyan-300/90 font-semibold">FAQ</div>
          <h2 className="mt-3 text-3xl sm:text-4xl font-semibold tracking-tight">
            Questions, answered.
          </h2>
        </div>
        <Accordion type="single" collapsible className="mt-10 w-full">
          {faqs.map((f, i) => (
            <AccordionItem key={i} value={`item-${i}`} className="border-border/50">
              <AccordionTrigger className="text-left text-base font-medium hover:no-underline">
                <span className="flex items-center gap-2">
                  <ChevronDown className="h-4 w-4 text-cyan-400 transition-transform" />
                  {f.q}
                </span>
              </AccordionTrigger>
              <AccordionContent className="text-muted-foreground leading-relaxed">
                {f.a}
              </AccordionContent>
            </AccordionItem>
          ))}
        </Accordion>
      </div>
    </section>
  );
}

/* ---------------- Final CTA ---------------- */

function FinalCTA({ onStart }: { onStart: () => void }) {
  return (
    <section className="py-20 sm:py-28 border-t border-border/40">
      <div className="mx-auto max-w-4xl px-5 sm:px-8">
        <div className="relative rounded-2xl overflow-hidden border border-border/60 bg-gradient-to-br from-slate-900/80 to-slate-950/90 p-8 sm:p-12">
          <div aria-hidden className="absolute -inset-1 opacity-30 blur-2xl pointer-events-none"
            style={{ background: "radial-gradient(40% 60% at 20% 30%, #22D3EE, transparent), radial-gradient(40% 60% at 80% 70%, #A78BFA, transparent)" }}
          />
          <div className="relative text-center">
            <h2 className="text-3xl sm:text-4xl md:text-5xl font-semibold tracking-tight">
              Find out where you stand{" "}
              <span className="bg-gradient-to-r from-cyan-300 to-sky-300 bg-clip-text text-transparent">before your role changes.</span>
            </h2>
            <p className="mt-4 text-muted-foreground text-base sm:text-lg max-w-2xl mx-auto">
              Run your first AI-risk check in under a minute. No credit card. Your data stays yours.
            </p>
            <div className="mt-7 flex flex-col sm:flex-row items-center justify-center gap-3">
              <Button
                onClick={onStart}
                size="lg"
                className="h-12 px-7 text-base bg-gradient-to-r from-cyan-400 to-sky-500 text-slate-950 hover:from-cyan-300 hover:to-sky-400 font-semibold shadow-xl shadow-sky-500/30"
                data-testid="button-final-start"
              >
                Start my AI risk check <ArrowRight className="ml-2 h-4 w-4" />
              </Button>
            </div>
            <p className="mt-5 text-xs text-muted-foreground max-w-2xl mx-auto">
              No subscription required · One credit = one full report · Secure checkout powered by Stripe ·
              Directional career-risk insight, not a guarantee.
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}

/* ---------------- Footer ---------------- */

function Footer() {
  return (
    <footer className="py-10 border-t border-border/40">
      <div className="mx-auto max-w-6xl px-5 sm:px-8 flex flex-col sm:flex-row items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <Logo />
        </div>
        <div className="text-xs text-muted-foreground text-center sm:text-right">
          © {new Date().getFullYear()} CareerProof AI. Career-risk intelligence is directional —
          not a guarantee. Use it to plan, not to panic.
        </div>
      </div>
    </footer>
  );
}
