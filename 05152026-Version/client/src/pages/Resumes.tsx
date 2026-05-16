import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import type { Resume } from "@shared/schema";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { FileText, Download, Trash2, Upload, ChevronDown, Loader2 } from "lucide-react";
import { useRef } from "react";
import { formatBytes, formatDate } from "@/lib/format";
import { useToast } from "@/hooks/use-toast";
import { Skeleton } from "@/components/ui/skeleton";

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

export default function Resumes() {
  const { toast } = useToast();
  const fileRef = useRef<HTMLInputElement | null>(null);
  const { data: resumes, isLoading } = useQuery<Resume[]>({ queryKey: ["/api/resumes"] });

  const upload = useMutation({
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
    onSuccess: (resume) => {
      queryClient.setQueryData<Resume[]>(["/api/resumes"], (old = []) => [
        resume,
        ...old.filter((r) => r.id !== resume.id),
      ]);
      queryClient.invalidateQueries({ queryKey: ["/api/resumes"] });
      toast({
        title: "Resume uploaded",
        description: `${resume.filename} is now saved in your library.`,
      });
    },
    onError: (err: any) =>
      toast({
        title: "Upload failed",
        description: String(err?.message ?? "Please try a smaller PDF, DOC, or DOCX file."),
        variant: "destructive",
      }),
  });

  const del = useMutation({
    mutationFn: async (id: number) => apiRequest("DELETE", `/api/resumes/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/resumes"] }),
  });

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    const ext = f.name.toLowerCase().slice(f.name.lastIndexOf("."));
    const okType = ACCEPTED_TYPES.includes(f.type) || ACCEPTED_EXT.includes(ext);
    if (!okType) {
      toast({ title: "Unsupported file", description: "Use PDF, DOC, or DOCX.", variant: "destructive" });
      e.target.value = "";
      return;
    }
    upload.mutate(f);
    e.target.value = "";
  };

  const download = (r: Resume) => {
    // file_url is a data: URL — open it in a new tab as a download.
    const a = document.createElement("a");
    a.href = r.file_url;
    a.download = r.filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  return (
    <div className="max-w-5xl mx-auto p-4 sm:p-6 lg:p-8 space-y-5">
      <header className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3">
          <div className="h-9 w-9 rounded-md bg-aurora-light dark:bg-aurora grid place-items-center">
            <FileText className="w-5 h-5 text-primary" />
          </div>
          <div>
            <h1 className="text-xl font-semibold tracking-tight">Resume library</h1>
            <p className="text-sm text-muted-foreground">Saved resumes for grounding your AI assessments.</p>
          </div>
        </div>
        <input
          ref={fileRef}
          type="file"
          accept=".pdf,.doc,.docx,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
          onChange={onFile}
          className="hidden"
          data-testid="input-file-resume-library"
        />
        <Button onClick={() => fileRef.current?.click()} disabled={upload.isPending} data-testid="button-upload-resume-library">
          {upload.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Upload className="w-4 h-4 mr-2" />}
          Upload resume
        </Button>
      </header>

      {isLoading ? (
        <div className="space-y-3">
          {Array.from({ length: 2 }).map((_, i) => (
            <Skeleton key={i} className="h-28 w-full" />
          ))}
        </div>
      ) : !resumes || resumes.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center">
            <FileText className="w-10 h-10 mx-auto text-muted-foreground mb-3" />
            <p className="font-medium">No resumes yet</p>
            <p className="text-sm text-muted-foreground mt-1">Upload a PDF, DOC, or DOCX to get started.</p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid sm:grid-cols-2 gap-3">
          {resumes.map((r) => (
            <Card key={r.id} data-testid={`card-resume-${r.id}`}>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm flex items-start gap-2">
                  <FileText className="w-4 h-4 text-primary mt-0.5 shrink-0" />
                  <span className="truncate" data-testid={`text-resume-name-${r.id}`}>{r.filename}</span>
                </CardTitle>
                <CardDescription className="text-xs">
                  {formatDate(r.created_date)} · {formatBytes(r.size_bytes)} · {r.content_type.split("/").pop()?.toUpperCase()}
                </CardDescription>
              </CardHeader>
              <CardContent className="pt-0 space-y-3">
                <Collapsible>
                  <CollapsibleTrigger asChild>
                    <Button variant="ghost" size="sm" className="w-full justify-between" data-testid={`button-toggle-preview-${r.id}`}>
                      Preview text
                      <ChevronDown className="w-3.5 h-3.5" />
                    </Button>
                  </CollapsibleTrigger>
                  <CollapsibleContent className="text-xs text-muted-foreground bg-muted/40 rounded-md p-3 mt-2 whitespace-pre-wrap" data-testid={`text-preview-${r.id}`}>
                    {r.extracted_text.slice(0, 500)}
                    {r.extracted_text.length > 500 && "…"}
                  </CollapsibleContent>
                </Collapsible>
                <div className="flex gap-2">
                  <Button size="sm" variant="outline" onClick={() => download(r)} data-testid={`button-download-${r.id}`}>
                    <Download className="w-3.5 h-3.5 mr-1.5" />
                    Download
                  </Button>
                  <AlertDialog>
                    <AlertDialogTrigger asChild>
                      <Button size="sm" variant="outline" data-testid={`button-delete-resume-${r.id}`}>
                        <Trash2 className="w-3.5 h-3.5 mr-1.5" />
                        Delete
                      </Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>Delete this resume?</AlertDialogTitle>
                        <AlertDialogDescription>{r.filename} will be permanently removed.</AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <AlertDialogAction onClick={() => del.mutate(r.id)} data-testid={`button-confirm-delete-resume-${r.id}`}>
                          Delete
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
