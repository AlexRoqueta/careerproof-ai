import { useEffect, useRef, useState } from "react";
import { useLocation } from "wouter";
import { useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  Brain,
  Loader2,
  Sparkles,
  Wand2,
  AlertTriangle,
  Lock,
  ArrowLeft,
  ArrowRight,
  ShieldCheck,
  Info,
} from "lucide-react";
import { Logo } from "@/components/Logo";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { track, EVENTS } from "@/lib/analytics";
import { writeAnonPreviewToken, type AnonPreviewPayload } from "@/lib/anonPreview";

/**
 * AnonymousAnalyze — the new top-of-funnel for unauthenticated visitors.
 *
 * Goal: cold ad traffic (Meta/Reels) needs to be able to generate a
 * useful AI job-risk preview WITHOUT creating an account first. We
 * gate sign-up behind two distinct user intents:
 *
 *   1. "Save this preview to my account / come back to it later"
 *   2. "Unlock the full report for $3"
 *
 * Either intent surfaces a Create Account / Sign In screen that
 * preserves the just-generated preview token. After auth the SignIn
 * screen calls /api/preview/:token/claim and lands the user inside
 * the (now-locked) full report — no rerun, no re-entry of details.
 */
export default function AnonymousAnalyze() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();

  const [jobTitle, setJobTitle] = useState("");
  const [jobDescription, setJobDescription] = useState("");
  const [techContext, setTechContext] = useState("");
  const [preview, setPreview] = useState<AnonPreviewPayload | null>(null);
  const previewRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    track(EVENTS.anonymous_preview_started);
  }, []);

  const autofill = useMutation({
    mutationFn: async () => {
      track(EVENTS.ai_autofill_started);
      const res = await apiRequest("POST", "/api/autofill", { job_title: jobTitle });
      return res.json() as Promise<{ job_description: string; technology_context: string }>;
    },
    onSuccess: (data) => {
      setJobDescription(data.job_description);
      setTechContext(data.technology_context);
      track(EVENTS.ai_autofill_completed);
      toast({ title: "Fields auto-filled", description: "Review or edit before generating." });
    },
    onError: () => toast({ title: "Auto-fill failed", variant: "destructive" }),
  });

  const analyze = useMutation({
    mutationFn: async () => {
      track(EVENTS.analysis_started, { anonymous: true });
      const res = await apiRequest("POST", "/api/preview/analyze", {
        job_title: jobTitle,
        job_description: jobDescription,
        technology_context: techContext || undefined,
      });
      return (await res.json()) as AnonPreviewPayload;
    },
    onSuccess: (data) => {
      setPreview(data);
      writeAnonPreviewToken(data.token);
      track(EVENTS.anonymous_preview_completed, {
        risk_score: data.risk_score,
        automation_risk: data.automation_risk,
      });
      track(EVENTS.preview_viewed, { anonymous: true, risk_score: data.risk_score });
      track(EVENTS.preview_report_viewed, { anonymous: true, risk_score: data.risk_score });
      requestAnimationFrame(() => {
        previewRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
      });
    },
    onError: (err: any) => {
      const message = String(err?.message ?? "");
      track(EVENTS.anonymous_preview_failed, { error: message.slice(0, 120) });
      // 429 — rate limited — surface a friendly message that nudges
      // the user toward signup if they want to keep going.
      if (message.startsWith("429")) {
        toast({
          title: "You've hit the free-preview limit",
          description:
            "Create a free account to keep generating previews and unlock the full report.",
          variant: "destructive",
        });
        return;
      }
      toast({
        title: "Preview failed",
        description: message.replace(/^\d+:\s*/, "") || "Try again in a moment.",
        variant: "destructive",
      });
    },
  });

  const onSubmit = () => {
    if (!jobTitle.trim() || !jobDescription.trim()) {
      toast({
        title: "Missing fields",
        description: "Job title and description are required to start your preview.",
      });
      return;
    }
    analyze.mutate();
  };

  const goSignIn = (intent: "save" | "unlock", source: string) => {
    if (preview?.token) writeAnonPreviewToken(preview.token);
    track(EVENTS.signup_prompt_shown, { source, intent, has_preview: !!preview });
    if (intent === "unlock") {
      track(EVENTS.unlock_cta_after_preview, { source });
    }
    setLocation("/signin");
    window.scrollTo({ top: 0, behavior: "auto" });
  };

  if (preview) {
    return (
      <AnonymousPreviewView
        ref={previewRef}
        preview={preview}
        onSignIn={goSignIn}
        onStartOver={() => {
          setPreview(null);
          // Don't clear the token yet — the user might still come back
          // and decide to save it. The token will TTL out on its own.
        }}
      />
    );
  }

  return (
    <div className="min-h-screen bg-background text-foreground antialiased">
      <Header
        right={
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setLocation("/")}
            data-testid="button-back-landing"
          >
            <ArrowLeft className="w-4 h-4 mr-1.5" />
            Back
          </Button>
        }
      />
      <div className="max-w-3xl mx-auto p-4 sm:p-6 lg:p-8 space-y-6">
        <div className="relative overflow-hidden rounded-xl border border-border bg-aurora-light dark:bg-aurora p-6 sm:p-8">
          <div className="inline-flex items-center gap-1.5 rounded-full border border-primary/30 bg-primary/10 px-2.5 py-1 text-[11px] font-medium text-primary mb-3">
            <Sparkles className="w-3 h-3" />
            Free preview · No account needed to start
          </div>
          <h1 className="text-2xl sm:text-3xl font-semibold tracking-tight">
            Start your free AI job-risk preview
          </h1>
          <p className="text-sm sm:text-base text-muted-foreground max-w-xl mt-2 leading-relaxed">
            Type a job title (we'll auto-fill the rest) and we'll generate your overall AI exposure
            score, a short summary, and the most vulnerable tasks. <strong>No account needed</strong> to see
            the preview — sign up later only if you want to save it or unlock the full report.
          </p>
        </div>

        <Card data-testid="card-input">
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <Wand2 className="w-4 h-4 text-primary" />
              Tell us about your role
            </CardTitle>
            <CardDescription className="text-xs">
              You can change every field. The AI auto-fill is optional.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            <div className="rounded-lg border border-primary/30 bg-gradient-to-br from-primary/10 via-primary/5 to-transparent p-4 sm:p-5">
              <div className="flex items-start gap-3">
                <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-md bg-primary/15 text-primary">
                  <Wand2 className="w-4 h-4" />
                </div>
                <div className="flex-1 min-w-0">
                  <h3 className="text-sm font-semibold text-foreground">
                    Just enter a Job Title — let AI fill the rest
                  </h3>
                  <p className="text-xs text-muted-foreground mt-1">
                    Type your role below and tap <strong>Auto-fill with AI</strong>. We'll generate a
                    description you can edit before we run the analysis.
                  </p>
                  <div className="mt-3 grid gap-3 sm:grid-cols-[1fr_auto] items-start">
                    <Input
                      id="job_title_primer"
                      value={jobTitle}
                      onChange={(e) => setJobTitle(e.target.value)}
                      placeholder="e.g. Senior Marketing Analyst"
                      data-testid="input-job-title-primer"
                      className="bg-background"
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && jobTitle.trim() && !autofill.isPending) {
                          e.preventDefault();
                          autofill.mutate();
                        }
                      }}
                    />
                    <Button
                      onClick={() => autofill.mutate()}
                      disabled={!jobTitle.trim() || autofill.isPending}
                      data-testid="button-autofill"
                      className="w-full sm:w-auto"
                    >
                      {autofill.isPending ? (
                        <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                      ) : (
                        <Wand2 className="w-4 h-4 mr-2" />
                      )}
                      Auto-fill with AI
                    </Button>
                  </div>
                </div>
              </div>
            </div>

            <div className="relative">
              <div className="absolute inset-0 flex items-center" aria-hidden="true">
                <div className="w-full border-t border-border/60" />
              </div>
              <div className="relative flex justify-center">
                <span className="bg-card px-2 text-[11px] uppercase tracking-wide text-muted-foreground">
                  or fill in the details
                </span>
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="job_title" className="text-sm">
                Job title<span className="text-destructive ml-0.5">*</span>
              </Label>
              <Input
                id="job_title"
                value={jobTitle}
                onChange={(e) => setJobTitle(e.target.value)}
                placeholder="e.g. Senior Marketing Analyst"
                data-testid="input-job-title"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="job_description" className="text-sm">
                Job description<span className="text-destructive ml-0.5">*</span>
              </Label>
              <Textarea
                id="job_description"
                value={jobDescription}
                onChange={(e) => setJobDescription(e.target.value)}
                placeholder="What does your day-to-day actually look like? List 3-7 main responsibilities."
                rows={5}
                className="resize-none"
                data-testid="input-job-description"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="tech_context" className="text-sm">
                Technology context <span className="text-muted-foreground text-xs">(optional)</span>
              </Label>
              <Textarea
                id="tech_context"
                value={techContext}
                onChange={(e) => setTechContext(e.target.value)}
                placeholder="Tools, software, AI systems already in your workflow…"
                rows={3}
                className="resize-none"
                data-testid="input-tech-context"
              />
            </div>
            <Alert
              className="border-primary/20 bg-primary/[0.03]"
              data-testid="alert-manual-accuracy-tip"
            >
              <Info className="w-4 h-4" />
              <AlertTitle>Tip: get a more accurate read</AlertTitle>
              <AlertDescription>
                A job title can start your preview, but your analysis is more accurate when
                you upload a resume or import your LinkedIn profile. Those options unlock
                after you{" "}
                <button
                  className="underline underline-offset-2 font-medium"
                  onClick={() => goSignIn("save", "anon_resume_hint")}
                >
                  create a free account
                </button>
                .
              </AlertDescription>
            </Alert>
          </CardContent>
        </Card>

        <Card data-testid="card-generate">
          <CardContent className="pt-6">
            <div className="flex flex-wrap items-center gap-2">
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium text-foreground">Ready when you are</div>
                <p className="text-xs text-muted-foreground">
                  Your preview is free. We'll show your AI exposure score and a short summary
                  before asking you to do anything else.
                </p>
              </div>
              <Button
                onClick={onSubmit}
                disabled={analyze.isPending}
                data-testid="button-generate-preview"
                size="lg"
              >
                {analyze.isPending ? (
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                ) : (
                  <Brain className="w-4 h-4 mr-2" />
                )}
                Generate free AI job-risk preview
              </Button>
            </div>
            <p className="mt-3 text-[11px] text-muted-foreground">
              No credit card · No account required to see the preview · Sign up only to save
              it or unlock the full report.
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function Header({ right }: { right?: React.ReactNode }) {
  return (
    <header className="sticky top-0 z-40 backdrop-blur-md bg-background/70 border-b border-border/60">
      <div className="mx-auto max-w-6xl px-5 sm:px-8 h-16 flex items-center justify-between">
        <Logo />
        {right}
      </div>
    </header>
  );
}

const AnonymousPreviewView = ({
  preview,
  onSignIn,
  onStartOver,
}: {
  preview: AnonPreviewPayload;
  onSignIn: (intent: "save" | "unlock", source: string) => void;
  onStartOver: () => void;
} & { ref?: React.RefObject<HTMLDivElement> }) => {
  const score = Math.max(0, Math.min(100, Math.round(preview.risk_score)));
  const tone =
    score >= 70 ? "from-rose-300 to-red-400" : score >= 40 ? "from-amber-300 to-orange-400" : "from-emerald-300 to-teal-400";
  const label =
    score >= 70 ? "High exposure" : score >= 40 ? "Moderate–High exposure" : "Lower exposure";

  return (
    <div className="min-h-screen bg-background text-foreground antialiased">
      <header className="sticky top-0 z-40 backdrop-blur-md bg-background/70 border-b border-border/60">
        <div className="mx-auto max-w-6xl px-5 sm:px-8 h-16 flex items-center justify-between">
          <Logo />
          <Button variant="ghost" size="sm" onClick={onStartOver} data-testid="button-start-over">
            <ArrowLeft className="w-4 h-4 mr-1.5" />
            New preview
          </Button>
        </div>
      </header>
      <div className="max-w-3xl mx-auto p-4 sm:p-6 lg:p-8 space-y-5" data-testid="view-anon-preview">
        <Alert className="border-cyan-400/30 bg-gradient-to-br from-cyan-500/10 via-sky-500/10 to-violet-500/10">
          <Sparkles className="w-4 h-4" />
          <AlertTitle>Your free AI job-risk preview is ready.</AlertTitle>
          <AlertDescription>
            This preview is yours — no account needed.{" "}
            <strong>Create a free account</strong> to save it, connect a resume or LinkedIn
            profile for a more accurate read, or unlock the full AI Exposure Report. Less than
            a latte — $3 (one credit).
          </AlertDescription>
        </Alert>

        <Card className="rounded-2xl border-border/60 bg-card/80 backdrop-blur p-5 sm:p-7">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <div>
              <div className="text-xs uppercase tracking-wider text-muted-foreground">Role analyzed</div>
              <div className="mt-1 text-lg sm:text-xl font-semibold" data-testid="text-job-title">
                {preview.job_title}
              </div>
            </div>
            <div className="text-[10px] font-medium uppercase tracking-wider text-cyan-300/90 px-2 py-0.5 rounded-full bg-cyan-500/10 border border-cyan-400/30">
              Free preview
            </div>
          </div>
          <div className="mt-5">
            <div className="flex items-end justify-between">
              <div>
                <div className="text-xs uppercase tracking-wider text-muted-foreground">Overall risk</div>
                <div className="mt-1 text-4xl sm:text-5xl font-semibold tracking-tight" data-testid="text-risk-score">
                  <span className={`bg-gradient-to-r ${tone} bg-clip-text text-transparent`}>{score}</span>
                  <span className="text-base font-medium text-muted-foreground ml-1">/100</span>
                </div>
                <div className="mt-1 text-sm font-medium" data-testid="text-risk-label">{label}</div>
              </div>
            </div>
            <div className="mt-4 h-2 w-full rounded-full bg-muted overflow-hidden">
              <div className="h-full rounded-full bg-gradient-to-r from-emerald-400 via-amber-400 to-rose-500" style={{ width: `${score}%` }} />
            </div>
          </div>
          {preview.summary && (
            <p
              className="mt-5 rounded-lg border border-border/60 bg-background/40 p-3 text-sm leading-relaxed"
              data-testid="text-preview-summary"
            >
              {preview.summary}
            </p>
          )}
          {preview.vulnerable_tasks.length > 0 && (
            <div className="mt-4" data-testid="list-preview-tasks">
              <div className="text-[11px] uppercase tracking-wider text-muted-foreground font-semibold">
                Most vulnerable tasks (preview)
              </div>
              <ul className="mt-2 space-y-1.5">
                {preview.vulnerable_tasks.slice(0, 3).map((t, i) => (
                  <li key={i} className="flex items-start gap-2 text-sm" data-testid={`row-preview-task-${i}`}>
                    <AlertTriangle className="w-3.5 h-3.5 mt-0.5 text-amber-300 shrink-0" />
                    <span>{t}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {preview.locked_sections.length > 0 && (
            <div className="mt-4">
              <div className="text-[11px] uppercase tracking-wider text-muted-foreground font-semibold">
                Unlock to read
              </div>
              <ul className="mt-2 grid grid-cols-1 sm:grid-cols-2 gap-1.5">
                {preview.locked_sections.map((s, i) => (
                  <li key={i} className="flex items-start gap-2 text-xs text-muted-foreground">
                    <Lock className="w-3 h-3 mt-0.5 shrink-0 text-amber-300/80" />
                    <span>{s}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <div className="mt-5 grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Button
              size="lg"
              onClick={() => onSignIn("unlock", "preview_primary_cta")}
              data-testid="button-unlock-cta"
              className="bg-gradient-to-r from-cyan-400 to-sky-500 text-slate-950 hover:from-cyan-300 hover:to-sky-400 font-semibold"
            >
              <Sparkles className="w-4 h-4 mr-2" />
              Unlock My Full Report
            </Button>
            <Button
              size="lg"
              variant="outline"
              onClick={() => onSignIn("save", "preview_save_cta")}
              data-testid="button-save-cta"
            >
              Save my preview
              <ArrowRight className="w-4 h-4 ml-2" />
            </Button>
          </div>
          <p className="mt-3 text-[11px] text-muted-foreground">
            <ShieldCheck className="w-3 h-3 inline mr-1" />
            Unlock the full report for less than a latte — $3 (one credit). No subscription.
            Your preview is saved to your account as soon as you sign up — no need to re-enter
            anything.
          </p>
          <p className="mt-2 text-[11px] text-muted-foreground leading-relaxed">
            A personalized career-risk review from a coach or counselor could cost
            $75–$300+ per hour. CareerProof AI gives you a fast, affordable,
            role-specific AI Exposure Report for just $3.
          </p>
        </Card>
      </div>
    </div>
  );
};
