import { useMe } from "@/hooks/useMe";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import type { User } from "@shared/schema";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectTrigger, SelectContent, SelectItem, SelectValue } from "@/components/ui/select";
import { ShieldCheck, Save, AlertTriangle } from "lucide-react";
import { useEffect, useState } from "react";
import { useToast } from "@/hooks/use-toast";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { formatDate } from "@/lib/format";
import { hasUnlimitedCredits } from "@shared/entitlements";

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
          <h1 className="text-xl font-semibold tracking-tight">Admin · Credit manager</h1>
          <p className="text-sm text-muted-foreground">Adjust credits across user accounts.</p>
        </div>
      </header>

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

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[11px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className="font-medium">{value}</div>
    </div>
  );
}
