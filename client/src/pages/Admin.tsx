import { useMe } from "@/hooks/useMe";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import type { User } from "@shared/schema";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectTrigger, SelectContent, SelectItem, SelectValue } from "@/components/ui/select";
import { ShieldCheck, Save, AlertTriangle, BarChart3 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useToast } from "@/hooks/use-toast";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { formatDate } from "@/lib/format";
import { hasUnlimitedCredits } from "@shared/entitlements";

interface AdminMetricsResponse {
  window: { since: string; until: string };
  promo: {
    active: boolean;
    name: string;
    limit: number;
    used: number | null;
    remaining: number | null;
    promo_price_cents: number;
    regular_price_cents: number;
    reference_suffix: string;
  } | null;
  funnel: Array<{ name: string; count: number }>;
  events_other: Array<{ name: string; count: number }>;
  ab_unlock_variant: Record<string, Array<{ variant: string | null; count: number }>>;
  referrals: { signups: number; purchases: number };
  users: { total: number };
}

function toIsoDateOnly(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export default function Admin() {
  const { data: me } = useMe();
  const { toast } = useToast();
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [credits, setCredits] = useState<string>("");

  const { data: users } = useQuery<User[]>({
    queryKey: ["/api/users"],
    enabled: me?.role === "admin",
  });

  const selectedUser = users?.find((u) => u.id === selectedId) ?? null;
  useEffect(() => {
    if (selectedUser) setCredits(String(selectedUser.credits));
  }, [selectedUser]);

  const save = useMutation({
    mutationFn: async () => {
      if (!selectedUser) return;
      return apiRequest("POST", "/api/users/set-credits", {
        user_id: selectedUser.id,
        credits: Number(credits),
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/users"] });
      queryClient.invalidateQueries({ queryKey: ["/api/me"] });
      toast({ title: "Credits updated" });
    },
    onError: () => toast({ title: "Update failed", variant: "destructive" }),
  });

  if (me && me.role !== "admin") {
    return (
      <div className="max-w-3xl mx-auto p-6">
        <Alert variant="destructive">
          <AlertTriangle className="w-4 h-4" />
          <AlertTitle>Admins only</AlertTitle>
          <AlertDescription>This page is restricted to admin accounts.</AlertDescription>
        </Alert>
      </div>
    );
  }

  return (
    <div className="max-w-5xl mx-auto p-4 sm:p-6 lg:p-8 space-y-5">
      <header className="flex items-center gap-3">
        <div className="h-9 w-9 rounded-md bg-aurora-light dark:bg-aurora grid place-items-center">
          <ShieldCheck className="w-5 h-5 text-primary" />
        </div>
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Admin · Dashboard</h1>
          <p className="text-sm text-muted-foreground">Promo redemptions, funnel metrics, and credit administration.</p>
        </div>
      </header>

      <AdminMetricsPanel />


      <Card>
        <CardHeader>
          <CardTitle className="text-base">Set credits</CardTitle>
          <CardDescription>Pick a user, set the credit balance, save.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="grid sm:grid-cols-[1fr_auto_auto] gap-3 items-end">
            <div className="space-y-1.5">
              <Label className="text-sm">User</Label>
              <Select
                value={selectedId ? String(selectedId) : undefined}
                onValueChange={(v) => setSelectedId(Number(v))}
              >
                <SelectTrigger data-testid="select-admin-user">
                  <SelectValue placeholder="Choose a user…" />
                </SelectTrigger>
                <SelectContent>
                  {(users ?? []).map((u) => (
                    <SelectItem key={u.id} value={String(u.id)} data-testid={`option-admin-user-${u.id}`}>
                      {u.full_name} ({u.email})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-sm">Credits</Label>
              <Input
                type="number"
                min={0}
                value={credits}
                onChange={(e) => setCredits(e.target.value)}
                disabled={!selectedUser}
                className="w-32"
                data-testid="input-admin-credits"
              />
            </div>
            <Button
              onClick={() => save.mutate()}
              disabled={!selectedUser || save.isPending}
              data-testid="button-save-credits"
            >
              <Save className="w-4 h-4 mr-2" />
              Save
            </Button>
          </div>

          {selectedUser && (
            <div className="rounded-md border border-border p-4 bg-muted/30 grid sm:grid-cols-4 gap-3 text-sm" data-testid="panel-user-details">
              <Detail label="Full name" value={selectedUser.full_name} />
              <Detail label="Email" value={selectedUser.email} />
              <Detail label="Role" value={selectedUser.role} />
              <Detail label="Created" value={formatDate(selectedUser.created_date)} />
              <Detail
                label="Credits"
                value={
                  hasUnlimitedCredits(selectedUser.email, selectedUser.role)
                    ? "Unlimited"
                    : String(selectedUser.credits)
                }
              />
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">All users</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto -mx-4 sm:mx-0">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wider text-muted-foreground">
                  <th className="px-4 py-2 font-medium">User</th>
                  <th className="px-4 py-2 font-medium">Email</th>
                  <th className="px-4 py-2 font-medium">Role</th>
                  <th className="px-4 py-2 font-medium text-right">Credits</th>
                  <th className="px-4 py-2 font-medium">Created</th>
                </tr>
              </thead>
              <tbody>
                {(users ?? []).map((u) => (
                  <tr key={u.id} className="border-t border-border" data-testid={`row-user-${u.id}`}>
                    <td className="px-4 py-3">{u.full_name}</td>
                    <td className="px-4 py-3 text-muted-foreground">{u.email}</td>
                    <td className="px-4 py-3 capitalize">{u.role}</td>
                    <td className="px-4 py-3 text-right tabular-nums">
                      {hasUnlimitedCredits(u.email, u.role) ? "∞" : u.credits}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">{formatDate(u.created_date)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function AdminMetricsPanel() {
  const today = useMemo(() => toIsoDateOnly(new Date()), []);
  const thirtyDaysAgo = useMemo(
    () => toIsoDateOnly(new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)),
    [],
  );
  const [since, setSince] = useState(thirtyDaysAgo);
  const [until, setUntil] = useState(today);

  const { data: metrics, isLoading, refetch, isFetching } = useQuery<AdminMetricsResponse>({
    queryKey: ["/api/admin/metrics", since, until],
    queryFn: async () => {
      const url = `/api/admin/metrics?since=${encodeURIComponent(`${since}T00:00:00.000Z`)}&until=${encodeURIComponent(`${until}T23:59:59.999Z`)}`;
      const res = await fetch(url, { credentials: "include" });
      if (!res.ok) throw new Error("metrics fetch failed");
      return res.json();
    },
  });

  return (
    <Card data-testid="card-admin-metrics">
      <CardHeader>
        <div className="flex items-start gap-3 justify-between flex-wrap">
          <div className="flex items-center gap-3">
            <div className="h-8 w-8 rounded-md bg-aurora-light dark:bg-aurora grid place-items-center">
              <BarChart3 className="w-4 h-4 text-primary" />
            </div>
            <div>
              <CardTitle className="text-base">Funnel & promo metrics</CardTitle>
              <CardDescription>Date-bounded view of first-party events, promo redemptions, and A/B variant performance.</CardDescription>
            </div>
          </div>
          <div className="flex items-end gap-2 flex-wrap">
            <div className="space-y-1">
              <Label className="text-xs">Since</Label>
              <Input
                type="date"
                value={since}
                onChange={(e) => setSince(e.target.value)}
                className="h-8 w-[140px]"
                data-testid="input-metrics-since"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Until</Label>
              <Input
                type="date"
                value={until}
                onChange={(e) => setUntil(e.target.value)}
                className="h-8 w-[140px]"
                data-testid="input-metrics-until"
              />
            </div>
            <Button
              size="sm"
              variant="outline"
              onClick={() => refetch()}
              disabled={isFetching}
              data-testid="button-metrics-refresh"
            >
              {isFetching ? "Loading…" : "Refresh"}
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-6">
        {isLoading && <p className="text-sm text-muted-foreground">Loading metrics…</p>}
        {metrics && (
          <>
            {/* Promo + revenue summary */}
            {metrics.promo && (
              <div className="grid sm:grid-cols-3 gap-3" data-testid="panel-promo-summary">
                <MetricTile
                  label={`Promo "${metrics.promo.name}"`}
                  value={metrics.promo.active ? "Active" : "Inactive"}
                />
                <MetricTile
                  label="Promo redemptions"
                  value={
                    metrics.promo.used != null
                      ? `${metrics.promo.used} / ${metrics.promo.limit}`
                      : `unknown / ${metrics.promo.limit}`
                  }
                />
                <MetricTile
                  label="Promo slots remaining"
                  value={metrics.promo.remaining != null ? String(metrics.promo.remaining) : "—"}
                />
              </div>
            )}

            {/* Funnel sequence */}
            <div>
              <div className="text-sm font-medium mb-2">Funnel events ({metrics.window.since.slice(0,10)} → {metrics.window.until.slice(0,10)})</div>
              <div className="overflow-x-auto -mx-4 sm:mx-0">
                <table className="w-full text-sm" data-testid="table-funnel-events">
                  <thead>
                    <tr className="text-left text-xs uppercase tracking-wider text-muted-foreground">
                      <th className="px-4 py-2 font-medium">Event</th>
                      <th className="px-4 py-2 font-medium text-right">Count</th>
                    </tr>
                  </thead>
                  <tbody>
                    {metrics.funnel.map((row) => (
                      <tr key={row.name} className="border-t border-border" data-testid={`row-funnel-${row.name}`}>
                        <td className="px-4 py-2">{row.name}</td>
                        <td className="px-4 py-2 text-right tabular-nums">{row.count.toLocaleString()}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {/* A/B unlock variant breakdown */}
            <div>
              <div className="text-sm font-medium mb-2">Unlock A/B variant performance</div>
              <div className="overflow-x-auto -mx-4 sm:mx-0">
                <table className="w-full text-sm" data-testid="table-ab-variants">
                  <thead>
                    <tr className="text-left text-xs uppercase tracking-wider text-muted-foreground">
                      <th className="px-4 py-2 font-medium">Event</th>
                      <th className="px-4 py-2 font-medium text-right">Variant A</th>
                      <th className="px-4 py-2 font-medium text-right">Variant B</th>
                      <th className="px-4 py-2 font-medium text-right">Untagged</th>
                    </tr>
                  </thead>
                  <tbody>
                    {Object.entries(metrics.ab_unlock_variant).map(([eventName, rows]) => {
                      const a = rows.find((r) => r.variant === "A")?.count ?? 0;
                      const b = rows.find((r) => r.variant === "B")?.count ?? 0;
                      const untagged = rows.find((r) => r.variant === null || r.variant === "")?.count ?? 0;
                      return (
                        <tr key={eventName} className="border-t border-border" data-testid={`row-ab-${eventName}`}>
                          <td className="px-4 py-2">{eventName}</td>
                          <td className="px-4 py-2 text-right tabular-nums">{a.toLocaleString()}</td>
                          <td className="px-4 py-2 text-right tabular-nums">{b.toLocaleString()}</td>
                          <td className="px-4 py-2 text-right tabular-nums text-muted-foreground">{untagged.toLocaleString()}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Referrals */}
            <div className="grid sm:grid-cols-3 gap-3" data-testid="panel-referrals">
              <MetricTile label="Referred signups" value={String(metrics.referrals.signups)} />
              <MetricTile label="Referred purchases" value={String(metrics.referrals.purchases)} />
              <MetricTile label="Users (total)" value={String(metrics.users.total)} />
            </div>

            {/* Other events */}
            {metrics.events_other.length > 0 && (
              <div>
                <div className="text-sm font-medium mb-2">Other tracked events</div>
                <ul className="text-sm text-muted-foreground list-disc pl-5">
                  {metrics.events_other.map((r) => (
                    <li key={r.name}><span className="font-medium text-foreground">{r.name}</span> — {r.count.toLocaleString()}</li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function MetricTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-border p-4 bg-muted/30">
      <div className="text-[11px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className="mt-1 text-lg font-semibold tabular-nums">{value}</div>
    </div>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[11px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className="font-medium">{value}</div>
    </div>
  );
}
