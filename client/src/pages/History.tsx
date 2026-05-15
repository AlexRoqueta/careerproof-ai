import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import type { Analysis } from "@shared/schema";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
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
import { Trash2, FileText, ChevronLeft, History as HistoryIcon } from "lucide-react";
import { useState } from "react";
import { formatDate, formatDateTime, riskColor, toTitleCase } from "@/lib/format";
import { ReportView } from "@/components/ReportView";
import { Skeleton } from "@/components/ui/skeleton";

export default function History() {
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const { data: analyses, isLoading } = useQuery<Analysis[]>({ queryKey: ["/api/analyses"] });

  const del = useMutation({
    mutationFn: async (id: number) => apiRequest("DELETE", `/api/analyses/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/analyses"] });
      setSelectedId(null);
    },
  });

  const selected = analyses?.find((a) => a.id === selectedId) ?? null;

  if (selected) {
    return (
      <div className="max-w-5xl mx-auto p-4 sm:p-6 lg:p-8 space-y-4">
        <div className="flex items-center justify-between gap-2">
          <Button
            variant="ghost"
            onClick={() => setSelectedId(null)}
            data-testid="button-back-history"
          >
            <ChevronLeft className="w-4 h-4 mr-1" />
            Back to history
          </Button>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="outline" data-testid="button-delete-analysis">
                <Trash2 className="w-4 h-4 mr-2" />
                Delete analysis
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Delete this analysis?</AlertDialogTitle>
                <AlertDialogDescription>This cannot be undone.</AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  onClick={() => del.mutate(selected.id)}
                  data-testid="button-confirm-delete-analysis"
                >
                  Delete
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
        <ReportView analysis={selected} />
      </div>
    );
  }

  return (
    <div className="max-w-5xl mx-auto p-4 sm:p-6 lg:p-8 space-y-5">
      <header className="flex items-center gap-3">
        <div className="h-9 w-9 rounded-md bg-aurora-light dark:bg-aurora grid place-items-center">
          <HistoryIcon className="w-5 h-5 text-primary" />
        </div>
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Analysis history</h1>
          <p className="text-sm text-muted-foreground">All assessments you've generated.</p>
        </div>
      </header>

      {isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-16 w-full" />
          ))}
        </div>
      ) : !analyses || analyses.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center">
            <FileText className="w-10 h-10 mx-auto text-muted-foreground mb-3" />
            <p className="font-medium">No analyses yet</p>
            <p className="text-sm text-muted-foreground mt-1">
              Run your first AI assessment from the Analyze tab.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {analyses.map((a) => (
            <button
              key={a.id}
              onClick={() => setSelectedId(a.id)}
              className="w-full text-left"
              data-testid={`card-analysis-${a.id}`}
            >
              <Card className="hover-elevate transition-colors">
                <CardContent className="py-4 flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="font-medium truncate" data-testid={`text-analysis-title-${a.id}`}>
                      {toTitleCase(a.job_title)}
                    </div>
                    <div className="text-xs text-muted-foreground mt-0.5">
                      {formatDateTime(a.created_date)}
                    </div>
                  </div>
                  <span
                    className={`shrink-0 inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium ${riskColor(a.automation_risk)}`}
                    data-testid={`badge-risk-${a.id}`}
                  >
                    {a.automation_risk} · {a.risk_score}
                  </span>
                </CardContent>
              </Card>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
