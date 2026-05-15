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
  Brain,
  Zap,
  Upload,
  Loader2,
  Sparkles,
  AlertTriangle,
  FileText,
  CheckCircle2,
  X as XIcon,
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

const ACCEPTED_TYPES = [
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
];
const ACCEPTED_EXT = [".pdf", ".doc", ".docx"];

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
  const abortRef = useRef<AbortController | null>(null);
  const prefillAbortRef = useRef<AbortController | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const latestPrefillResumeId = useRef<number | null>(null);

  const { data: resumes = [] } = useQuery<Resume[]>({ queryKey: ["/api/resumes"] });

  const selectResumeForPrefill = (id: number, uploadedResume?: Resume) => {
    // Aggressively invalidate ANY analysis-derived state from the
    // previous resume so a stale title / banner / image cannot leak
    // across selections.
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
  };

  const autofillMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/autofill", { job_title: jobTitle });
      return res.json() as Promise<{ job_description: string; technology_context: string }>;
    },
    onSuccess: (data) => {
      setJobDescription(data.job_description);
      setTechContext(data.technology_context);
      toast({ title: "Fields auto-filled", description: "Review and refine before generating." });
    },
    onError: () => toast({ title: "Auto-fill failed", variant: "destructive" }),
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
      // Discard any response whose resume_id no longer matches the
      // currently selected resume — prevents an in-flight response
      // from a previously-selected resume from overwriting fresh state.
      if (latestPrefillResumeId.current !== requestedResumeId) return;
      setJobTitle(data.job_title);
      setJobDescription(data.job_description);
      setTechContext(data.technology_context);
      toast({ title: "Pre-filled from resume" });
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
      const res = await fetch(apiUrl("/api/analyses"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
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
      return;
    }
    // Zero-credit users can still run an analysis — the backend returns
    // a locked report (header / score / section titles visible, body
    // obfuscated until credits are added).
    setResultAnalysis(null);
    analyzeMutation.mutate();
  };

  // Clear result when fields reset
  useEffect(() => () => abortRef.current?.abort(), []);

  if (resultAnalysis) {
    return (
      <div className="max-w-5xl mx-auto p-4 sm:p-6 lg:p-8">
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
            Generate a data-driven assessment of automation risk, where AI lands first, and a concrete 90-day action plan.
          </p>
        </div>
      </div>

      {/* Resume source */}
      <Card data-testid="card-resume-source">
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <FileText className="w-4 h-4 text-primary" />
            Resume context <span className="text-xs font-normal text-muted-foreground ml-1">(optional)</span>
          </CardTitle>
          <CardDescription>Upload a resume or pick a saved one to ground the assessment.</CardDescription>
        </CardHeader>
        <CardContent>
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
        </CardContent>
      </Card>

      {/* Inputs */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Role details</CardTitle>
          <CardDescription>Be specific — the more context, the better the analysis.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
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

          <div className="flex flex-wrap gap-2">
            <Button
              variant="secondary"
              onClick={() => autofillMutation.mutate()}
              disabled={!jobTitle.trim() || autofillMutation.isPending || prefillFromResume.isPending}
              data-testid="button-autofill"
            >
              {autofillMutation.isPending ? (
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              ) : (
                <Zap className="w-4 h-4 mr-2" />
              )}
              Auto-fill fields
            </Button>
            <div className="flex-1" />
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
              >
                <Brain className="w-4 h-4 mr-2" />
                {prefillFromResume.isPending ? "Updating resume fields…" : "Generate AI analysis"}
              </Button>
            )}
          </div>

          {prefillFromResume.isPending && (
            <Alert data-testid="alert-prefilling-resume">
              <Loader2 className="w-4 h-4 animate-spin" />
              <AlertTitle>Updating from selected resume…</AlertTitle>
              <AlertDescription>
                Clearing the previous analysis and loading the selected resume’s job title and description.
              </AlertDescription>
            </Alert>
          )}

          {analyzeMutation.isPending && (
            <Alert data-testid="alert-analyzing">
              <Loader2 className="w-4 h-4 animate-spin" />
              <AlertTitle>Analyzing…</AlertTitle>
              <AlertDescription>
                Synthesizing role context, task profile, and AI exposure. Usually under 5 seconds.
              </AlertDescription>
            </Alert>
          )}

          {me && !unlimitedCredits && me.credits <= 0 && (
            <Alert data-testid="alert-no-credits">
              <AlertTriangle className="w-4 h-4" />
              <AlertTitle>You’re out of credits — locked report preview</AlertTitle>
              <AlertDescription>
                You can still generate an analysis. The report header, automation
                score, and section titles will be visible, but the readable body
                stays blurred until you{" "}
                <button
                  className="underline underline-offset-2 font-medium"
                  onClick={() => setShowBuy(true)}
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
