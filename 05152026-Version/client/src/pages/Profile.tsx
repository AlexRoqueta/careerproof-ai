import { useMe } from "@/hooks/useMe";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { User as UserIcon, Mail, Calendar, CreditCard, ShieldCheck, RefreshCw } from "lucide-react";
import { formatDate } from "@/lib/format";
import { Skeleton } from "@/components/ui/skeleton";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useQuery, useMutation } from "@tanstack/react-query";
import type { User } from "@shared/schema";
import { hasUnlimitedCredits } from "@shared/entitlements";

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
