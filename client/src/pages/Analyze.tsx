import { useState, useRef, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import {
  Brain,
  Zap,
  Upload,
  Loader2,
  Sparkles,
  AlertTriangle,
  FileText,
  CheckCircle2,
  X as XIcon,
  Linkedin,
  Keyboard,
  Info,
  Download,
  Wand2,
} from "lucide-react";
import { MicButton } from "@/components/MicButton";
import { BuyCreditsModal } from "@/components/BuyCreditsModal";
import { useMe } from "@/hooks/useMe";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient, apiUrl } from "@/lib/queryClient";
import type { Resume, Analysis } from "@shared/schema";
import { hasUnlimitedCredits } from "@shared/entitlements";
import { ReportView } from "@/components/ReportView";
import { useToast } from "@/hooks/use-toast";
import { useLocation } from "wouter";
import { track, EVENTS } from "@/lib/analytics";
import { takeJustClaimedAnalysisId } from "@/lib/anonPreview";

const ACCEPTED_TYPES = [
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
];
const ACCEPTED_EXT = [".pdf", ".doc", ".docx"];

type PanelId = "resume" | "linkedin" | "manual";

function readFileAsDataURL(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

export default function Analyze() {
  const { data: me } = useMe();
  const { toast } = useToast();
  const [, setLocation] = useLocation();
  const unlimitedCredits = hasUnlimitedCredits(me?.email, me?.role);

  const [jobTitle, setJobTitle] = useState("");
  const [jobDescription, setJobDescription] = useState("");
  const [techContext, setTechContext] = useState("");
  const [resumeId, setResumeId] = useState<number | null>(null);
  const [resumeTab, setResumeTab] = useState("existing");
  const [lastUploadedResume, setLastUploadedResume] = useState<Resume | null>(null);
  const [showBuy, setShowBuy] = useState(false);
  const [resultAnalysis, setResultAnalysis] = useState<Analysis | null>(null);
  const [linkedinUrl, setLinkedinUrl] = useState("");
  const [linkedinPasted, setLinkedinPasted] = useState("");
  const [linkedinWarning, setLinkedinWarning] = useState<string | null>(null);
  const [linkedinDiagnostics, setLinkedinDiagnostics] = useState<{
    confidence: number;
    confidence_label: "high" | "medium" | "low";
    warnings: string[];
  } | null>(null);
  const [linkedinCompany, setLinkedinCompany] = useState("");
  const [linkedinLocation, setLinkedinLocation] = useState("");
  // Single-open accordion. Default to all collapsed so the post-signin
  // page presents three clear choices instead of a wall of inputs.
  const [openPanel, setOpenPanel] = useState<PanelId | "">("");
  const abortRef = useRef<AbortController | null>(null);
  const prefillAbortRef = useRef<AbortController | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const latestPrefillResumeId = useRef<number | null>(null);
  const roleDetailsRef = useRef<HTMLDivElement | null>(null);

  /* Smoothly scroll to a field by id and (optionally) focus it. Used
   * after a programmatic populate — LinkedIn import, resume prefill,
   * AI auto-fill — so the user lands on the field they need to review
   * instead of being stuck mid-form. We never call this on each
   * keystroke (would create scroll loops during manual typing) and
   * never auto-focus inputs the user is already interacting with. */
  const scrollToField = (id: string, opts?: { focus?: boolean }) => {
    if (typeof window === "undefined") return;
    requestAnimationFrame(() => {
      const el = document.getElementById(id);
      if (!el) return;
      const active = document.activeElement;
      const userIsTyping =
        active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement;
      const target = userIsTyping ? roleDetailsRef.current ?? el : el;
      target.scrollIntoView({ behavior: "smooth", block: "center" });
      if (opts?.focus && !userIsTyping && (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) {
        try {
          el.focus({ preventScroll: true });
        } catch {
          /* focus failures are non-fatal */
        }
      }
    });
  };

  const fieldToReviewAfterPopulate = (data: {
    job_title?: string;
    job_description?: string;
  }): string => {
    if (!data.job_title?.trim()) return "job_title";
    if (!data.job_description?.trim()) return "job_description";
    return "job_title";
  };

  const { data: resumes = [] } = useQuery<Resume[]>({ queryKey: ["/api/resumes"] });

  const selectResumeForPrefill = (id: number, uploadedResume?: Resume) => {
    abortRef.current?.abort();
    prefillAbortRef.current?.abort();
    latestPrefillResumeId.current = id;
    setResumeId(id);
    setLastUploadedResume(uploadedResume ?? null);
    setResultAnalysis(null);
    setJobTitle("");
    setJobDescription("");
    setTechContext("");
    prefillFromResume.mutate(id);
    // Open the manual panel so the prefilled fields are visible for review.
    setOpenPanel("manual");
  };

  const clearResumeSelection = () => {
    abortRef.current?.abort();
    prefillAbortRef.current?.abort();
    latestPrefillResumeId.current = null;
    setResumeId(null);
    setLastUploadedResume(null);
    setResultAnalysis(null);
    setJobTitle("");
    setJobDescription("");
    setTechContext("");
    setLinkedinUrl("");
    setLinkedinPasted("");
    setLinkedinWarning(null);
    setLinkedinDiagnostics(null);
    setLinkedinCompany("");
    setLinkedinLocation("");
    setOpenPanel("");
  };

  const autofillMutation = useMutation({
    mutationFn: async () => {
      track(EVENTS.ai_autofill_started);
      const res = await apiRequest("POST", "/api/autofill", { job_title: jobTitle });
      return res.json() as Promise<{ job_description: string; technology_context: string }>;
    },
    onSuccess: (data) => {
      setJobDescription(data.job_description);
      setTechContext(data.technology_context);
      track(EVENTS.ai_autofill_completed);
      toast({ title: "Fields auto-filled", description: "Review and refine before generating." });
      scrollToField("job_description", { focus: true });
    },
    onError: () => toast({ title: "Auto-fill failed", variant: "destructive" }),
  });

  type LinkedInImportResponse = {
    source: "pasted" | "fetch" | "fetch-failed";
    engine?: "ai" | "heuristic";
    parsed: {
      job_title: string;
      company: string;
      location: string;
      job_description: string;
      technology_context?: string;
      employment_type?: string;
      seniority?: string;
    };
    warning?: string;
    ai_warning?: string;
    confidence?: number;
    confidence_label?: "high" | "medium" | "low";
    warnings?: string[];
  };

  const linkedinImportMutation = useMutation({
    mutationFn: async () => {
      const url = linkedinUrl.trim();
      const pasted_text = linkedinPasted.trim();
      track(EVENTS.linkedin_import_started, { has_url: Boolean(url), has_text: Boolean(pasted_text) });
      const res = await apiRequest("POST", "/api/linkedin/import", {
        url: url || undefined,
        pasted_text: pasted_text || undefined,
      });
      return res.json() as Promise<LinkedInImportResponse>;
    },
    onSuccess: (data) => {
      track(EVENTS.linkedin_import_completed, { source: data.source, engine: data.engine ?? "n/a" });
      setLinkedinWarning(data.warning ?? null);
      setLinkedinDiagnostics(
        data.confidence != null && data.confidence_label
          ? {
              confidence: data.confidence,
              confidence_label: data.confidence_label,
              warnings: data.warnings ?? [],
            }
          : null,
      );
      const { parsed, source, warning, engine } = data;
      // Fail-closed rule: when confidence is low, only populate fields
      // the user can sanity-check (title / company / location). Never
      // dump a low-confidence description into job_description — that's
      // the field where login / language / footer / CSS noise tends to
      // leak through. The user will be prompted to paste the About and
      // Experience sections (via the warnings block) so a high-
      // confidence retry can populate the description.
      const lowConfidence = data.confidence_label === "low";
      if (parsed.job_title) setJobTitle(parsed.job_title);
      if (parsed.job_description && !lowConfidence) setJobDescription(parsed.job_description);
      if (parsed.company) setLinkedinCompany(parsed.company);
      if (parsed.location) setLinkedinLocation(parsed.location);
      if (parsed.technology_context && parsed.technology_context.trim()) {
        setTechContext(parsed.technology_context);
      }

      if (source === "fetch-failed") {
        toast({
          title: "Couldn't reach LinkedIn",
          description:
            warning ?? "Paste the job text from LinkedIn into the box below — it works reliably.",
        });
        return;
      }
      if (!parsed.job_title && !parsed.job_description) {
        toast({
          title: "Nothing recognisable",
          description:
            "Couldn't extract a job title or description. Try pasting the full job description text from LinkedIn.",
        });
        return;
      }
      const sourceLabel =
        source === "fetch" ? "Fetched from URL" : "Parsed from pasted text";
      const engineLabel = engine === "ai" ? " using AI" : "";
      toast({
        title: "LinkedIn job imported",
        description: `${sourceLabel}${engineLabel} — review and edit before generating.`,
      });
      // Surface the populated fields so the user can review them.
      setOpenPanel("manual");
      scrollToField(fieldToReviewAfterPopulate(parsed), { focus: true });
    },
    onError: (err: any) => {
      const message = String(err?.message ?? "Unknown error");
      const friendly = message.replace(/^\d+:\s*/, "");
      toast({
        title: "LinkedIn import failed",
        description: friendly || "Try pasting the LinkedIn job text instead.",
        variant: "destructive",
      });
    },
  });

  const prefillFromResume = useMutation({
    mutationFn: async (id: number) => {
      const controller = new AbortController();
      prefillAbortRef.current = controller;
      const res = await apiRequest(
        "POST",
        "/api/resumes/prefill",
        { resume_id: id },
        controller.signal,
      );
      return res.json() as Promise<{ job_title: string; job_description: string; technology_context: string }>;
    },
    onSuccess: (data, requestedResumeId) => {
      if (latestPrefillResumeId.current !== requestedResumeId) return;
      setJobTitle(data.job_title);
      setJobDescription(data.job_description);
      setTechContext(data.technology_context);
      toast({ title: "Pre-filled from resume" });
      scrollToField(fieldToReviewAfterPopulate(data), { focus: true });
    },
    onError: (err: any) => {
      if (err?.name === "AbortError") return;
      toast({ title: "Resume pre-fill failed", variant: "destructive" });
    },
  });

  const uploadResume = useMutation({
    mutationFn: async (file: File) => {
      const data_url = await readFileAsDataURL(file);
      const res = await apiRequest("POST", "/api/resumes", {
        filename: file.name,
        content_type: file.type || "application/octet-stream",
        size_bytes: file.size,
        data_url,
      });
      return res.json() as Promise<Resume>;
    },
    onSuccess: async (resume) => {
      queryClient.setQueryData<Resume[]>(["/api/resumes"], (old = []) => [
        resume,
        ...old.filter((r) => r.id !== resume.id),
      ]);
      queryClient.invalidateQueries({ queryKey: ["/api/resumes"] });
      setResumeTab("existing");
      track(EVENTS.resume_uploaded, { size_bytes: resume.size_bytes });
      toast({
        title: "Resume uploaded",
        description: `${resume.filename} is selected and will be used to pre-fill the role details.`,
      });
      selectResumeForPrefill(resume.id, resume);
    },
    onError: (err: any) =>
      toast({
        title: "Upload failed",
        description: String(err?.message ?? "Please try a smaller PDF, DOC, or DOCX file."),
        variant: "destructive",
      }),
  });

  const analyzeMutation = useMutation({
    mutationFn: async () => {
      const controller = new AbortController();
      abortRef.current = controller;
      track(EVENTS.analysis_started, { has_resume: resumeId != null });
      const res = await fetch(apiUrl("/api/analyses"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        credentials: "include",
        body: JSON.stringify({
          job_title: jobTitle,
          job_description: jobDescription,
          technology_context: techContext || undefined,
          resume_id: resumeId ?? undefined,
        }),
      });
      if (!res.ok) throw new Error(await res.text());
      return (await res.json()) as Analysis;
    },
    onSuccess: async (a) => {
      setResultAnalysis(a);
      track(EVENTS.analysis_completed, {
        analysis_id: a.id,
        risk_score: a.risk_score,
        automation_risk: a.automation_risk,
        locked: Boolean(a.is_locked),
      });
      await queryClient.invalidateQueries({ queryKey: ["/api/me"] });
      await queryClient.invalidateQueries({ queryKey: ["/api/analyses"] });
    },
    onError: (err: any) => {
      if (err?.name === "AbortError") {
        toast({ title: "Analysis cancelled" });
        return;
      }
      toast({ title: "Analysis failed", description: String(err?.message), variant: "destructive" });
    },
  });

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    const ext = f.name.toLowerCase().slice(f.name.lastIndexOf("."));
    const okType = ACCEPTED_TYPES.includes(f.type) || ACCEPTED_EXT.includes(ext);
    if (!okType) {
      toast({
        title: "Unsupported file",
        description: "Use PDF, DOC, or DOCX.",
        variant: "destructive",
      });
      e.target.value = "";
      return;
    }
    uploadResume.mutate(f);
    e.target.value = "";
  };

  const cancelAnalysis = () => {
    abortRef.current?.abort();
  };

  const onAnalyze = () => {
    if (prefillFromResume.isPending) {
      toast({ title: "Resume still loading", description: "Wait for the selected resume fields to finish updating." });
      return;
    }
    if (!jobTitle.trim() || !jobDescription.trim()) {
      toast({ title: "Missing fields", description: "Job title and description are required." });
      // Open the manual panel so the user can see which fields are missing.
      setOpenPanel("manual");
      return;
    }
    setResultAnalysis(null);
    analyzeMutation.mutate();
  };

  useEffect(() => () => abortRef.current?.abort(), []);

  /* Pick up an analysis that was just claimed from an anonymous
   * preview (sign-up/in path). The id is one-shot — once we consume it
   * we fetch the saved record and hand it to ReportView. The user
   * lands directly inside their saved (locked) report with all the
   * preview data intact, no rerun needed. */
  useEffect(() => {
    const claimedId = takeJustClaimedAnalysisId();
    if (claimedId == null) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await apiRequest("GET", `/api/analyses/${claimedId}`);
        const a = (await res.json()) as Analysis;
        if (!cancelled) setResultAnalysis(a);
      } catch {
        /* If the fetch fails the user can still kick off a new analysis. */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!resultAnalysis) return;
    if (typeof window === "undefined") return;
    requestAnimationFrame(() => {
      const target = document.getElementById("analysis-report-top");
      if (target) {
        target.scrollIntoView({ behavior: "smooth", block: "start" });
      } else {
        window.scrollTo({ top: 0, behavior: "smooth" });
      }
    });
  }, [resultAnalysis?.id]);

  if (resultAnalysis) {
    return (
      <div id="analysis-report-top" className="max-w-5xl mx-auto p-4 sm:p-6 lg:p-8">
        <div className="flex items-center justify-between mb-4 gap-2">
          <Button
            variant="ghost"
            onClick={() => clearResumeSelection()}
            data-testid="button-new-analysis"
          >
            <XIcon className="w-4 h-4 mr-2" />
            New analysis
          </Button>
          <Button
            variant="outline"
            onClick={() => setLocation(`/history`)}
            data-testid="button-view-history"
          >
            View history
          </Button>
        </div>
        <ReportView analysis={resultAnalysis} onAnalysisUpdated={setResultAnalysis} />
      </div>
    );
  }

  const panelHeader = (
    icon: React.ReactNode,
    title: string,
    subtitle: string,
    badge?: React.ReactNode,
  ) => (
    <div className="flex items-start gap-3 text-left flex-1">
      <div className="mt-0.5 flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
        {icon}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-medium text-foreground">{title}</span>
          {badge}
        </div>
        <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">
          {subtitle}
        </p>
      </div>
    </div>
  );

  const optionalBadge = (
    <span className="text-[10px] uppercase tracking-wide font-medium text-muted-foreground border border-border/60 rounded px-1.5 py-0.5">
      Optional
    </span>
  );

  return (
    <div className="max-w-5xl mx-auto p-4 sm:p-6 lg:p-8 space-y-6">
      {/* Hero */}
      <div className="relative overflow-hidden rounded-xl border border-border bg-aurora-light dark:bg-aurora p-6 sm:p-8">
        <div className="absolute inset-0 grid-bg opacity-30 pointer-events-none" />
        <div className="relative">
          <div className="inline-flex items-center gap-1.5 rounded-full border border-primary/30 bg-primary/10 px-2.5 py-1 text-[11px] font-medium text-primary mb-3">
            <Sparkles className="w-3 h-3" />
            AI Career Impact
          </div>
          <h1 className="text-xl font-semibold tracking-tight mb-1.5 text-foreground">
            Will AI <span className="text-gradient">reshape</span> your role?
          </h1>
          <p className="text-sm text-muted-foreground max-w-xl">
            Get your free AI job-risk preview — overall exposure score, short summary,
            and the most vulnerable tasks. Unlock the full AI Exposure Report (detailed
            task breakdown, skills to build, 90-day action plan, PDF export) for $3.
          </p>
        </div>
      </div>

      {/* Compact "how it works" hint */}
      <Card data-testid="card-input-methods" className="border-primary/20 bg-primary/[0.03]">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <Info className="w-4 h-4 text-primary" />
            Choose one way to start
          </CardTitle>
          <CardDescription className="text-xs">
            You can upload a resume, import LinkedIn information, or enter a job title manually.
          </CardDescription>
        </CardHeader>
      </Card>

      {/* Accordion: Resume upload → LinkedIn import → Manually enter Job information */}
      <Card data-testid="card-input-accordion">
        <CardContent className="p-2 sm:p-3">
          <Accordion
            type="single"
            collapsible
            value={openPanel}
            onValueChange={(v) => {
              const panel = (v as PanelId) || "";
              if (panel) {
                const method =
                  panel === "resume"
                    ? "resume_upload"
                    : panel === "linkedin"
                    ? "linkedin_import"
                    : "manual_entry";
                track(EVENTS.input_method_selected, { method });
              }
              setOpenPanel(panel);
            }}
            className="w-full"
          >
            {/* 1. Resume upload */}
            <AccordionItem value="resume" data-testid="panel-resume" className="border-b last:border-b-0">
              <AccordionTrigger
                className="px-2 sm:px-3 py-3 hover:no-underline hover:bg-muted/40 rounded-md"
                data-testid="trigger-resume"
              >
                {panelHeader(
                  <FileText className="w-4 h-4" />,
                  "Resume upload",
                  "Upload a resume or pick a saved one — we pre-fill role details from it.",
                  optionalBadge,
                )}
              </AccordionTrigger>
              <AccordionContent className="px-2 sm:px-3 pt-1">
                <Tabs value={resumeTab} onValueChange={setResumeTab}>
                  <TabsList className="grid grid-cols-2 w-full sm:w-auto">
                    <TabsTrigger value="existing" data-testid="tab-existing-resume">Existing</TabsTrigger>
                    <TabsTrigger value="upload" data-testid="tab-upload-resume">Upload new</TabsTrigger>
                  </TabsList>
                  <TabsContent value="existing" className="mt-4">
                    {resumes.length === 0 ? (
                      <p className="text-sm text-muted-foreground">No resumes yet — upload one or skip.</p>
                    ) : (
                      <div className="space-y-3">
                        <Select
                          value={resumeId ? String(resumeId) : undefined}
                          onValueChange={(v) => {
                            const id = Number(v);
                            selectResumeForPrefill(id);
                          }}
                        >
                          <SelectTrigger className="w-full sm:w-[400px]" data-testid="select-resume">
                            <SelectValue placeholder="Choose a saved resume…" />
                          </SelectTrigger>
                          <SelectContent>
                            {resumes.map((r) => (
                              <SelectItem key={r.id} value={String(r.id)} data-testid={`option-resume-${r.id}`}>
                                {r.filename}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        {resumeId && (
                          <Alert data-testid="alert-selected-resume" className="border-cyan-500/30 bg-cyan-500/10">
                            <CheckCircle2 className="w-4 h-4" />
                            <AlertTitle>Resume selected</AlertTitle>
                            <AlertDescription>
                              {(lastUploadedResume ?? resumes.find((r) => r.id === resumeId))?.filename ??
                                "This resume"}{" "}
                              is saved and being used to ground the analysis.
                            </AlertDescription>
                          </Alert>
                        )}
                      </div>
                    )}
                  </TabsContent>
                  <TabsContent value="upload" className="mt-4">
                    <input
                      ref={fileRef}
                      type="file"
                      accept=".pdf,.doc,.docx,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                      onChange={onFile}
                      className="hidden"
                      data-testid="input-file-resume"
                    />
                    <Button
                      variant="outline"
                      onClick={() => fileRef.current?.click()}
                      disabled={uploadResume.isPending}
                      data-testid="button-upload-resume"
                    >
                      {uploadResume.isPending ? (
                        <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                      ) : (
                        <Upload className="w-4 h-4 mr-2" />
                      )}
                      {uploadResume.isPending ? "Uploading…" : "Upload PDF / DOC / DOCX"}
                    </Button>
                    <p className="text-xs text-muted-foreground mt-2">
                      Accepts <strong>PDF</strong>, <strong>DOC</strong>, or <strong>DOCX</strong>. Files are
                      stored privately to your account.
                    </p>
                  </TabsContent>
                </Tabs>
              </AccordionContent>
            </AccordionItem>

            {/* 2. LinkedIn import */}
            <AccordionItem value="linkedin" data-testid="panel-linkedin" className="border-b last:border-b-0">
              <AccordionTrigger
                className="px-2 sm:px-3 py-3 hover:no-underline hover:bg-muted/40 rounded-md"
                data-testid="trigger-linkedin"
              >
                {panelHeader(
                  <Linkedin className="w-4 h-4" />,
                  "LinkedIn import",
                  "Paste a LinkedIn job URL or visible job text — we extract title and description.",
                  optionalBadge,
                )}
              </AccordionTrigger>
              <AccordionContent className="px-2 sm:px-3 pt-1">
                <div className="space-y-4">
                  <p className="text-xs text-muted-foreground">
                    Paste a LinkedIn job URL <em>and/or</em> the visible job text. You can also paste your{" "}
                    <strong>own LinkedIn profile</strong> (About + current Experience) to analyse your current role.
                    No LinkedIn login is required and credentials are never collected.
                  </p>
                  <div className="space-y-1.5">
                    <Label htmlFor="linkedin_url" className="text-sm">LinkedIn job URL</Label>
                    <Input
                      id="linkedin_url"
                      value={linkedinUrl}
                      onChange={(e) => setLinkedinUrl(e.target.value)}
                      placeholder="https://www.linkedin.com/jobs/view/..."
                      data-testid="input-linkedin-url"
                      autoComplete="off"
                      spellCheck={false}
                    />
                    <p className="text-xs text-muted-foreground">
                      Many LinkedIn pages require a login, so URL fetching can fail. If it does, paste the job text below.
                    </p>
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="linkedin_text" className="text-sm">Or paste the job text — or your LinkedIn profile / current role</Label>
                    <Textarea
                      id="linkedin_text"
                      value={linkedinPasted}
                      onChange={(e) => setLinkedinPasted(e.target.value)}
                      placeholder={"Paste a LinkedIn job (title, company, location, description) — or paste your own LinkedIn profile (headline, About, current Experience, Specialties / Skills). We detect which one it is."}
                      rows={5}
                      className="resize-none"
                      data-testid="input-linkedin-text"
                    />
                  </div>
                  <div className="flex flex-wrap gap-2 items-center">
                    <Button
                      variant="secondary"
                      onClick={() => linkedinImportMutation.mutate()}
                      disabled={
                        linkedinImportMutation.isPending ||
                        (!linkedinUrl.trim() && !linkedinPasted.trim())
                      }
                      data-testid="button-linkedin-import"
                    >
                      {linkedinImportMutation.isPending ? (
                        <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                      ) : (
                        <Download className="w-4 h-4 mr-2" />
                      )}
                      Import from LinkedIn
                    </Button>
                    {(linkedinCompany || linkedinLocation) && (
                      <span className="text-xs text-muted-foreground">
                        {linkedinCompany && <span data-testid="linkedin-company"><strong>{linkedinCompany}</strong></span>}
                        {linkedinCompany && linkedinLocation && <span> · </span>}
                        {linkedinLocation && <span data-testid="linkedin-location">{linkedinLocation}</span>}
                      </span>
                    )}
                  </div>
                  {linkedinWarning && (
                    <Alert variant="default" data-testid="alert-linkedin-warning">
                      <AlertTriangle className="w-4 h-4" />
                      <AlertTitle>
                        {/(preview|limited\s+linkedin)/i.test(linkedinWarning)
                          ? "Limited LinkedIn content detected"
                          : "Couldn't fetch from LinkedIn"}
                      </AlertTitle>
                      <AlertDescription>{linkedinWarning}</AlertDescription>
                    </Alert>
                  )}
                  {linkedinDiagnostics && (
                    <div
                      data-testid="panel-linkedin-diagnostics"
                      className="rounded-md border border-border/60 bg-background/40 p-3 text-xs leading-relaxed space-y-2"
                    >
                      <div className="flex items-center justify-between gap-2 flex-wrap">
                        <span className="font-medium">Import confidence</span>
                        <span
                          data-testid="text-linkedin-confidence"
                          className={
                            "rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wider " +
                            (linkedinDiagnostics.confidence_label === "high"
                              ? "bg-emerald-500/15 text-emerald-300 border border-emerald-400/30"
                              : linkedinDiagnostics.confidence_label === "medium"
                              ? "bg-amber-500/15 text-amber-300 border border-amber-400/30"
                              : "bg-rose-500/15 text-rose-300 border border-rose-400/30")
                          }
                        >
                          {linkedinDiagnostics.confidence_label} ({linkedinDiagnostics.confidence}/100)
                        </span>
                      </div>
                      {linkedinDiagnostics.warnings.length > 0 ? (
                        <ul className="list-disc pl-5 space-y-1 text-muted-foreground">
                          {linkedinDiagnostics.warnings.map((w, i) => (
                            <li key={i} data-testid={`linkedin-warning-${i}`}>{w}</li>
                          ))}
                        </ul>
                      ) : (
                        <p className="text-muted-foreground">All four core fields looked clean — review and edit before generating.</p>
                      )}
                      {linkedinDiagnostics.confidence_label === "low" && (
                        <p className="text-muted-foreground italic">
                          We left the description blank rather than fill it with low-confidence
                          content. Paste the About and Experience sections from your profile
                          (signed in) for a richer import.
                        </p>
                      )}
                    </div>
                  )}
                </div>
              </AccordionContent>
            </AccordionItem>

            {/* 3. Manually enter Job information */}
            <AccordionItem value="manual" data-testid="panel-manual" className="border-b-0">
              <AccordionTrigger
                className="px-2 sm:px-3 py-3 hover:no-underline hover:bg-muted/40 rounded-md"
                data-testid="trigger-manual"
              >
                {panelHeader(
                  <Keyboard className="w-4 h-4" />,
                  "Manually enter Job information",
                  "Type a title — let AI fill the rest — or fill every field yourself.",
                )}
              </AccordionTrigger>
              <AccordionContent className="px-2 sm:px-3 pt-1">
                <div ref={roleDetailsRef} className="space-y-5">
                  {/* Prominent AI-fill primer at the top of the panel.
                   * Encourages the "type a title, let AI handle the rest" path. */}
                  <div
                    className="rounded-lg border border-primary/30 bg-gradient-to-br from-primary/10 via-primary/5 to-transparent p-4 sm:p-5"
                    data-testid="autofill-primer"
                  >
                    <div className="flex items-start gap-3">
                      <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-md bg-primary/15 text-primary">
                        <Wand2 className="w-4 h-4" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <h3 className="text-sm font-semibold text-foreground">
                            Just enter a Job Title — let AI fill the rest
                          </h3>
                          <span className="text-[10px] uppercase tracking-wide font-medium rounded bg-primary/15 text-primary px-1.5 py-0.5">
                            Fastest
                          </span>
                        </div>
                        <p className="text-xs text-muted-foreground mt-1">
                          Type a job title below and tap <strong>Auto-fill with AI</strong>. We’ll generate a
                          description and technology context you can edit before generating.
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
                              if (
                                e.key === "Enter" &&
                                jobTitle.trim() &&
                                !autofillMutation.isPending &&
                                !prefillFromResume.isPending
                              ) {
                                e.preventDefault();
                                autofillMutation.mutate();
                              }
                            }}
                          />
                          <Button
                            onClick={() => autofillMutation.mutate()}
                            disabled={
                              !jobTitle.trim() ||
                              autofillMutation.isPending ||
                              prefillFromResume.isPending
                            }
                            data-testid="button-autofill"
                            className="w-full sm:w-auto"
                          >
                            {autofillMutation.isPending ? (
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

                  <Alert
                    className="border-primary/20 bg-primary/[0.03]"
                    data-testid="alert-manual-accuracy-tip"
                  >
                    <Info className="w-4 h-4" />
                    <AlertTitle>Tip: get a more accurate read</AlertTitle>
                    <AlertDescription>
                      A job title can start your preview, but your analysis is more accurate
                      when you upload a resume or import your LinkedIn profile from the panels
                      above.
                    </AlertDescription>
                  </Alert>

                  <FieldWithMic
                    id="job_title"
                    label="Job title"
                    required
                    value={jobTitle}
                    onChange={setJobTitle}
                    placeholder="e.g. Senior Marketing Analyst"
                    testId="input-job-title"
                    multiline={false}
                  />
                  <FieldWithMic
                    id="job_description"
                    label="Job description"
                    required
                    value={jobDescription}
                    onChange={setJobDescription}
                    placeholder="What does your day-to-day actually look like? List 3-7 main responsibilities."
                    testId="input-job-description"
                    multiline
                    rows={5}
                  />
                  <FieldWithMic
                    id="tech_context"
                    label="Technology context"
                    value={techContext}
                    onChange={setTechContext}
                    placeholder="Tools, software, AI systems already in your workflow…"
                    testId="input-tech-context"
                    multiline
                    rows={3}
                  />

                  {prefillFromResume.isPending && (
                    <Alert data-testid="alert-prefilling-resume">
                      <Loader2 className="w-4 h-4 animate-spin" />
                      <AlertTitle>Updating from selected resume…</AlertTitle>
                      <AlertDescription>
                        Clearing the previous analysis and loading the selected resume’s job title and description.
                      </AlertDescription>
                    </Alert>
                  )}
                </div>
              </AccordionContent>
            </AccordionItem>
          </Accordion>
        </CardContent>
      </Card>

      {/* Always-visible generate action — works regardless of which panel
       * the fields were populated from (resume, LinkedIn, or manual). */}
      <Card data-testid="card-generate">
        <CardContent className="pt-6">
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium text-foreground">Ready when you are</div>
              <p className="text-xs text-muted-foreground">
                Job title and description are required. We’ll use whichever fields you’ve filled in above.
              </p>
            </div>
            {analyzeMutation.isPending ? (
              <Button
                variant="destructive"
                onClick={cancelAnalysis}
                data-testid="button-cancel-analysis"
              >
                <XIcon className="w-4 h-4 mr-2" />
                Cancel analysis
              </Button>
            ) : (
              <Button
                onClick={onAnalyze}
                disabled={analyzeMutation.isPending || prefillFromResume.isPending}
                data-testid="button-generate"
                size="lg"
              >
                <Brain className="w-4 h-4 mr-2" />
                {prefillFromResume.isPending ? "Updating resume fields…" : "Generate AI analysis"}
              </Button>
            )}
          </div>

          {analyzeMutation.isPending && (
            <Alert data-testid="alert-analyzing" className="mt-4">
              <Loader2 className="w-4 h-4 animate-spin" />
              <AlertTitle>Analyzing…</AlertTitle>
              <AlertDescription>
                Synthesizing role context, task profile, and AI exposure. Usually under 5 seconds.
              </AlertDescription>
            </Alert>
          )}

          {me && !unlimitedCredits && me.credits <= 0 && (
            <Alert data-testid="alert-no-credits" className="mt-4">
              <AlertTriangle className="w-4 h-4" />
              <AlertTitle>You’re out of credits — locked report preview</AlertTitle>
              <AlertDescription>
                You can still generate an analysis. The report header, automation
                score, and section titles will be visible, but the readable body
                stays blurred until you{" "}
                <button
                  className="underline underline-offset-2 font-medium"
                  onClick={() => {
                    track(EVENTS.buy_credits_clicked, { source: "analyze_alert" });
                    setShowBuy(true);
                  }}
                  data-testid="link-buy-credits"
                >
                  buy credits
                </button>
                .
              </AlertDescription>
            </Alert>
          )}
        </CardContent>
      </Card>

      <BuyCreditsModal open={showBuy} onOpenChange={setShowBuy} />
    </div>
  );
}

function FieldWithMic({
  id,
  label,
  required,
  value,
  onChange,
  placeholder,
  multiline,
  rows,
  testId,
}: {
  id: string;
  label: string;
  required?: boolean;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  multiline?: boolean;
  rows?: number;
  testId: string;
}) {
  const handleTranscript = (t: string) => {
    onChange(value ? `${value} ${t}` : t);
  };
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <Label htmlFor={id} className="text-sm">
          {label}
          {required && <span className="text-destructive ml-0.5">*</span>}
        </Label>
        <MicButton onTranscript={handleTranscript} testId={`${testId}-mic`} />
      </div>
      {multiline ? (
        <Textarea
          id={id}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          rows={rows ?? 4}
          data-testid={testId}
          className="resize-none"
        />
      ) : (
        <Input
          id={id}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          data-testid={testId}
        />
      )}
    </div>
  );
}
