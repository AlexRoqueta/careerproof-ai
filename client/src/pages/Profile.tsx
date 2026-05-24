import { useMe } from "@/hooks/useMe";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { User as UserIcon, Mail, Calendar, CreditCard, ShieldCheck, RefreshCw, Share2, Copy, Check } from "lucide-react";
import { formatDate } from "@/lib/format";
import { Skeleton } from "@/components/ui/skeleton";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useQuery, useMutation } from "@tanstack/react-query";
import type { User } from "@shared/schema";
import { hasUnlimitedCredits } from "@shared/entitlements";
import { useState } from "react";
import { useToast } from "@/hooks/use-toast";
import { track } from "@/lib/analytics";

export default function Profile() {
  const { data: me, isLoading } = useMe();
  const unlimitedCredits = hasUnlimitedCredits(me?.email, me?.role);

  // The "Switch user" affordance is admin-only and is wired to the
  // /api/me/switch endpoint, which is also admin-gated server-side.
  // It exists for support / impersonation; non-admin sessions never
  // see this card.
  const { data: users } = useQuery<User[]>({
    queryKey: ["/api/users"],
    enabled: me?.role === "admin",
  });
  const switchUser = useMutation({
    mutationFn: async (user_id: number) => apiRequest("POST", "/api/me/switch", { user_id }),
    onSuccess: () => queryClient.invalidateQueries(),
  });

  if (isLoading || !me) {
    return (
      <div className="max-w-3xl mx-auto p-6 space-y-4">
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto p-4 sm:p-6 lg:p-8 space-y-5">
      <header className="flex items-center gap-3">
        <div className="h-9 w-9 rounded-md bg-aurora-light dark:bg-aurora grid place-items-center">
          <UserIcon className="w-5 h-5 text-primary" />
        </div>
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Profile</h1>
          <p className="text-sm text-muted-foreground">Your account details.</p>
        </div>
      </header>

      <Card>
        <CardHeader className="bg-aurora-light dark:bg-aurora rounded-t-lg">
          <div className="flex items-center gap-4">
            <div className="h-14 w-14 rounded-full bg-background border border-border grid place-items-center text-lg font-semibold">
              {me.full_name
                .split(" ")
                .map((p) => p[0])
                .join("")
                .slice(0, 2)
                .toUpperCase()}
            </div>
            <div>
              <CardTitle className="text-base" data-testid="text-profile-name">{me.full_name}</CardTitle>
              <CardDescription className="flex items-center gap-1.5 mt-0.5">
                {unlimitedCredits && <ShieldCheck className="w-3.5 h-3.5 text-primary" />}
                <span className="capitalize" data-testid="text-profile-role">
                  {unlimitedCredits ? "unlimited" : me.role}
                </span>
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="pt-5 grid sm:grid-cols-3 gap-4">
          <Field icon={Mail} label="Email" value={me.email} testId="text-profile-email" />
          <Field icon={Calendar} label="Account created" value={formatDate(me.created_date)} testId="text-profile-created" />
          <Field
            icon={CreditCard}
            label="Total credits"
            value={unlimitedCredits ? "Unlimited" : String(me.credits)}
            testId="text-profile-credits"
          />
        </CardContent>
      </Card>

      <ReferralCard />

      {me.role === "admin" && users && (
        <Card data-testid="card-switch-user">
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <RefreshCw className="w-4 h-4 text-primary" />
              Switch active account (admin)
            </CardTitle>
            <CardDescription>
              Impersonate another account for support and triage. The active session moves to the selected user until you switch back.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {users.map((u) => (
              <div
                key={u.id}
                className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2"
              >
                <div className="min-w-0">
                  <div className="text-sm font-medium truncate">{u.full_name}</div>
                  <div className="text-xs text-muted-foreground truncate">{u.email} · {u.role}</div>
                </div>
                <Button
                  size="sm"
                  variant={u.id === me.id ? "secondary" : "outline"}
                  disabled={u.id === me.id || switchUser.isPending}
                  onClick={() => switchUser.mutate(u.id)}
                  data-testid={`button-switch-user-${u.id}`}
                >
                  {u.id === me.id ? "Active" : "Switch"}
                </Button>
              </div>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function ReferralCard() {
  const { toast } = useToast();
  const [copied, setCopied] = useState(false);
  const { data, isLoading } = useQuery<{ code: string; created_at: string }>({
    queryKey: ["/api/referrals/me"],
    queryFn: async () => {
      const res = await fetch("/api/referrals/me", { credentials: "include" });
      if (!res.ok) throw new Error("referral fetch failed");
      return res.json();
    },
  });
  const code = data?.code ?? "";
  const origin = typeof window !== "undefined" ? window.location.origin : "https://careerproof.app";
  const shareUrl = code ? `${origin}/?ref=${code}` : "";

  const copy = async () => {
    if (!shareUrl) return;
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      track("referral_link_copied", { code });
      setTimeout(() => setCopied(false), 1500);
      toast({ title: "Link copied", description: "Share it with anyone curious about their AI exposure." });
    } catch {
      toast({ title: "Couldn't copy", description: "Long-press the link to copy.", variant: "destructive" });
    }
  };

  const share = async () => {
    if (!shareUrl) return;
    track("referral_link_shared", { code });
    if (navigator.share) {
      try {
        await navigator.share({
          title: "CareerProof AI — free AI job-risk preview",
          text: "Curious how exposed your job is to AI? This took me 2 minutes and the preview is free:",
          url: shareUrl,
        });
        return;
      } catch {
        // user dismissed — fall back to copy.
      }
    }
    copy();
  };

  return (
    <Card data-testid="card-referral">
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <Share2 className="w-4 h-4 text-primary" />
          Share CareerProof AI
        </CardTitle>
        <CardDescription>
          Send a friend the free AI job-risk preview. Your link tracks who you brought in (we don't pay
          referrals automatically — this is attribution + reporting only).
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {isLoading ? (
          <Skeleton className="h-9 w-full" />
        ) : (
          <div className="flex flex-col sm:flex-row gap-2">
            <Input
              readOnly
              value={shareUrl}
              className="font-mono text-xs sm:text-sm"
              data-testid="input-referral-url"
            />
            <div className="flex gap-2">
              <Button variant="outline" onClick={copy} data-testid="button-referral-copy">
                {copied ? <Check className="w-4 h-4 mr-1.5" /> : <Copy className="w-4 h-4 mr-1.5" />}
                {copied ? "Copied" : "Copy"}
              </Button>
              <Button onClick={share} data-testid="button-referral-share">
                <Share2 className="w-4 h-4 mr-1.5" />
                Share
              </Button>
            </div>
          </div>
        )}
        <p className="text-xs text-muted-foreground">
          Suggested message: "Curious how exposed your job is to AI? CareerProof AI gives you a
          role-specific AI Exposure Report in 2 minutes — the preview is free."
        </p>
      </CardContent>
    </Card>
  );
}

function Field({
  icon: Icon,
  label,
  value,
  testId,
}: {
  icon: any;
  label: string;
  value: string;
  testId?: string;
}) {
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wider text-muted-foreground">
        <Icon className="w-3 h-3" />
        {label}
      </div>
      <div className="text-sm font-medium capitalize:first-letter" data-testid={testId}>{value}</div>
    </div>
  );
}
