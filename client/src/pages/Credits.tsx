import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  CreditCard,
  Check,
  Sparkles,
  AlertCircle,
  Gift,
  Loader2,
  Receipt,
  FlaskConical,
  ArrowUpRight,
  ArrowDownRight,
  ShieldCheck,
} from "lucide-react";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useMe } from "@/hooks/useMe";
import { useToast } from "@/hooks/use-toast";
import { useEffect, useMemo, useState } from "react";
import { useLocation } from "wouter";
import { readPaymentCallbackParams, clearPaymentCallbackParams } from "@/App";
import {
  hasUnlimitedCredits,
  type CreditPackage,
  formatPrice,
} from "@shared/entitlements";
import type { CreditTransaction } from "@shared/schema";

/* =====================================================================
 * Credits page \u2014 provider-agnostic purchase, promo redemption, history
 *
 * - Packages are loaded from the server (/api/payments/packages) along
 *   with the active payment provider's metadata. The page does NOT hard-
 *   code Stripe; if/when the operator switches PAYMENT_PROVIDER, the UI
 *   reflects the change automatically.
 * - The preview provider returns a loopback URL that re-enters the same
 *   page with status=preview-success + session_id + token. The client
 *   POSTs the session to /api/payments/complete-checkout, which verifies
 *   the signature and grants credits via the ledger.
 * - Transaction history reads from /api/credits/transactions \u2014 every
 *   purchase, promo grant, unlock spend, and admin adjustment shows up
 *   in a single feed with running balance.
 * - The 10FREE promo code itself is NEVER shown or hinted to the user.
 *   The promo input is a plain text field with no placeholder leak.
 * ===================================================================== */

interface PackagesResponse {
  packages: CreditPackage[];
  provider: {
    name: string;
    display_name: string;
    is_preview: boolean;
  };
}

interface CheckoutResponse {
  checkout_url: string;
  session_id: string;
  package: CreditPackage;
  provider: string;
  preview: boolean;
  /* Preview-only completion payload. Live providers redirect the buyer
   * to a hosted checkout URL and NEVER include verification fields in
   * this response — the field stays null. The Credits page uses this
   * payload to complete preview purchases inline (same-window), which
   * sidesteps the hash-route-vs-search-query routing problem entirely. */
  preview_completion: { session_id: string; token: string } | null;
}

interface CompleteResponse {
  user: { credits: number };
  credits_added: number;
  already_processed: boolean;
  package: CreditPackage;
}

export default function Credits() {
  const { data: me } = useMe();
  const { toast } = useToast();
  const [location] = useLocation();
  const [promoCode, setPromoCode] = useState("");
  const [completionStatus, setCompletionStatus] = useState<
    | { kind: "success"; credits: number; already: boolean }
    | { kind: "cancel" }
    | { kind: "error"; message: string }
    | null
  >(null);
  const unlimitedCredits = hasUnlimitedCredits(me?.email, me?.role);

  const packagesQuery = useQuery<PackagesResponse>({
    queryKey: ["/api/payments/packages"],
  });
  const transactionsQuery = useQuery<{ transactions: CreditTransaction[] }>({
    queryKey: ["/api/credits/transactions"],
  });

  /* Provider callback params, captured by the App-level normalizer in
   * App.tsx and stashed for us to read after the route matches. The
   * App.tsx hook strips any `?status=...` from the URL (in both the
   * search and hash portions) BEFORE wouter tries to match the route,
   * so the Credits page always mounts cleanly on `/credits`. We read
   * the params on mount and clear them so a manual refresh of
   * `/#/credits` does not re-trigger completion.
   *
   * Two real flows reach this page:
   *   - Preview inline completion: no callback params; the buy
   *     mutation calls complete-checkout directly from
   *     `checkout.onSuccess`. This is the normal path for the preview
   *     provider on Render.
   *   - Live provider redirect: the provider redirected the buyer back
   *     to /credits with `?status=preview-success&session_id=...&
   *     token=...`. The App-level normalizer captured those fields
   *     before they could break route matching. */
  const callbackParams = useMemo(() => {
    return readPaymentCallbackParams();
    // location is in the deps so we re-read if wouter ever fires a
    // location change between mount and the effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location]);

  const completeCheckout = useMutation({
    mutationFn: async (input: { session_id: string; token: string }) => {
      const res = await apiRequest("POST", "/api/payments/complete-checkout", input);
      return (await res.json()) as CompleteResponse;
    },
    onSuccess: async (data) => {
      await queryClient.invalidateQueries({ queryKey: ["/api/me"] });
      await queryClient.invalidateQueries({ queryKey: ["/api/credits/transactions"] });
      setCompletionStatus({
        kind: "success",
        credits: data.credits_added,
        already: data.already_processed,
      });
      /* Clear callback params from BOTH the search and hash portions so
       * a refresh doesn't re-trigger this effect. Preserve the hash
       * path (`#/credits`) so the user stays on the page. */
      const hashPath = (window.location.hash.split("?")[0]) || "#/credits";
      window.history.replaceState(null, "", `${window.location.pathname}${hashPath}`);
    },
    onError: (err: any) => {
      setCompletionStatus({
        kind: "error",
        message: err?.message ?? "Could not complete the preview purchase.",
      });
    },
  });

  /* Fallback: if a provider redirect dropped verification fields in the
   * URL, the App-level normalizer captured them and routed us here.
   * Complete the purchase server-side now. The primary path is the
   * inline completion in `checkout.onSuccess` below — that path runs
   * without the URL ever changing. */
  useEffect(() => {
    if (!callbackParams) return;
    const status = callbackParams.get("status");
    if (status === "preview-success") {
      const session_id = callbackParams.get("session_id") ?? "";
      const token = callbackParams.get("token") ?? "";
      if (session_id && token && !completeCheckout.isPending) {
        completeCheckout.mutate({ session_id, token });
      }
    } else if (status === "preview-cancel") {
      setCompletionStatus({ kind: "cancel" });
    }
    clearPaymentCallbackParams();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [callbackParams]);

  const checkout = useMutation({
    mutationFn: async (pkg: CreditPackage) => {
      const res = await apiRequest("POST", "/api/payments/create-checkout", {
        package_id: pkg.id,
      });
      return (await res.json()) as CheckoutResponse;
    },
    onSuccess: (data) => {
      /* Preview provider: complete the purchase inline in the same
       * window. The server returned `preview_completion` with the
       * signed session fields; we POST them straight to
       * /api/payments/complete-checkout, which writes the ledger row
       * and updates the user's balance. No redirect — the URL never
       * changes, so wouter route matching and React state stay
       * consistent. The amber preview banner makes it clear this is
       * NOT a real payment.
       *
       * Live providers (Stripe etc.): preview_completion is null and
       * preview is false. We hand the browser off to the provider's
       * hosted checkout URL exactly as before. The provider then
       * redirects back to /#/credits and the App-level URL watcher in
       * App.tsx triggers the same complete-checkout endpoint. */
      if (data.preview && data.preview_completion) {
        completeCheckout.mutate(data.preview_completion);
        return;
      }
      window.location.href = data.checkout_url;
    },
    onError: () => {
      toast({
        title: "Could not start checkout",
        description: "Please try again in a moment.",
        variant: "destructive",
      });
    },
  });

  const redeemPromo = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/credits/redeem-code", { code: promoCode });
      return (await res.json()) as { credits_added: number; unlimited: boolean };
    },
    onSuccess: async (data) => {
      await queryClient.invalidateQueries({ queryKey: ["/api/me"] });
      await queryClient.invalidateQueries({ queryKey: ["/api/credits/transactions"] });
      setPromoCode("");
      if (data.unlimited) {
        toast({
          title: "Unlimited credits already active",
          description: "This account already has unlimited analyses \u2014 no credits were added.",
        });
      } else {
        toast({
          title: "Promo code redeemed",
          description: `${data.credits_added} free credit${data.credits_added === 1 ? "" : "s"} added to your account.`,
        });
      }
    },
    onError: async (err: any) => {
      // apiRequest throws on non-2xx with .message = "<status>: <body>".
      // Try to surface the server's specific message (already redeemed,
      // invalid code, etc.) while keeping the user-facing copy clear.
      let message = "Check the code and try again.";
      let title = "Invalid promo code";
      const raw = String(err?.message ?? "");
      if (raw.includes("already been redeemed")) {
        title = "Promo code already used";
        message = "This promo code has already been redeemed on your account.";
      } else if (raw.includes("isn\u2019t valid") || raw.includes("isn't valid")) {
        title = "Invalid promo code";
        message = "That promo code isn\u2019t valid. Check the code and try again.";
      }
      toast({ title, description: message, variant: "destructive" });
    },
  });

  const providerInfo = packagesQuery.data?.provider;
  const packages = packagesQuery.data?.packages ?? [];
  const transactions = transactionsQuery.data?.transactions ?? [];

  return (
    <div className="max-w-5xl mx-auto p-4 sm:p-6 lg:p-8 space-y-5">
      <header className="flex items-center gap-3">
        <div className="h-9 w-9 rounded-md bg-aurora-light dark:bg-aurora grid place-items-center">
          <CreditCard className="w-5 h-5 text-primary" />
        </div>
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Credits</h1>
          <p className="text-sm text-muted-foreground">
            One credit per assessment.{" "}
            {unlimitedCredits
              ? "You have unlimited credits."
              : `You currently have ${me?.credits ?? 0} credit${me?.credits === 1 ? "" : "s"}.`}
          </p>
        </div>
      </header>

      {unlimitedCredits && (
        <Alert data-testid="alert-unlimited-credits" className="border-cyan-500/30 bg-cyan-500/10">
          <Sparkles className="w-4 h-4" />
          <AlertTitle>Unlimited credits enabled</AlertTitle>
          <AlertDescription>
            The signed-in email is entitled to unlimited AI analyses, so purchases are optional.
          </AlertDescription>
        </Alert>
      )}

      {providerInfo?.is_preview && (
        <Alert data-testid="alert-preview-provider" className="border-amber-500/40 bg-amber-500/10">
          <FlaskConical className="w-4 h-4" />
          <AlertTitle>Preview checkout \u2014 no real payment is processed</AlertTitle>
          <AlertDescription>
            This build runs against an internal preview payment provider. Clicking
            <strong> Buy </strong> simulates a successful purchase and adds credits to your
            account so you can exercise the full flow. No card is charged, and no
            payment processor has been wired yet.
          </AlertDescription>
        </Alert>
      )}

      {completionStatus?.kind === "success" && (
        <Alert data-testid="alert-payment-success" className="border-emerald-500/30 bg-emerald-500/10">
          <Check className="w-4 h-4" />
          <AlertTitle>
            {completionStatus.already
              ? "Purchase already applied"
              : providerInfo?.is_preview
                ? "Preview purchase complete"
                : "Purchase complete"}
          </AlertTitle>
          <AlertDescription>
            {completionStatus.already
              ? "We've already credited this session to your account."
              : `${completionStatus.credits} credit${completionStatus.credits === 1 ? "" : "s"} added to your account.`}
          </AlertDescription>
        </Alert>
      )}
      {completionStatus?.kind === "cancel" && (
        <Alert variant="destructive" data-testid="alert-payment-cancel">
          <AlertCircle className="w-4 h-4" />
          <AlertTitle>Checkout cancelled</AlertTitle>
          <AlertDescription>No credits were added.</AlertDescription>
        </Alert>
      )}
      {completionStatus?.kind === "error" && (
        <Alert variant="destructive" data-testid="alert-payment-error">
          <AlertCircle className="w-4 h-4" />
          <AlertTitle>Could not complete checkout</AlertTitle>
          <AlertDescription>{completionStatus.message}</AlertDescription>
        </Alert>
      )}

      {/* Packages grid */}
      <div className="grid md:grid-cols-3 gap-4" data-testid="grid-packages">
        {packagesQuery.isLoading && (
          <Card>
            <CardContent className="py-8 text-sm text-muted-foreground">
              Loading packages\u2026
            </CardContent>
          </Card>
        )}
        {packages.map((pkg) => (
          <Card
            key={pkg.id}
            className={`relative ${pkg.popular ? "border-primary/60 ring-1 ring-primary/30" : ""}`}
            data-testid={`card-package-${pkg.id}`}
          >
            {pkg.popular && (
              <div className="absolute -top-2 left-1/2 -translate-x-1/2 inline-flex items-center gap-1 rounded-full bg-primary text-primary-foreground px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider">
                <Sparkles className="w-2.5 h-2.5" />
                Popular
              </div>
            )}
            <CardHeader>
              <CardDescription className="text-xs">{pkg.description}</CardDescription>
              <CardTitle className="text-xl flex items-baseline gap-1.5">
                <span className="tabular-nums">{pkg.credits}</span>
                <span className="text-sm font-normal text-muted-foreground">
                  credit{pkg.credits === 1 ? "" : "s"}
                </span>
              </CardTitle>
              <div className="text-[11px] uppercase tracking-wider text-muted-foreground mt-1">
                {pkg.name}
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="text-2xl font-semibold tabular-nums">
                {formatPrice(pkg.price_cents, pkg.currency)}
              </div>
              <ul className="space-y-1.5 text-sm">
                <li className="flex items-start gap-2">
                  <Check className="w-3.5 h-3.5 mt-1 text-primary shrink-0" />
                  <span>
                    {pkg.credits} AI assessment{pkg.credits === 1 ? "" : "s"}
                  </span>
                </li>
                <li className="flex items-start gap-2">
                  <Check className="w-3.5 h-3.5 mt-1 text-primary shrink-0" />
                  <span>PDF export &amp; sharing</span>
                </li>
                <li className="flex items-start gap-2">
                  <Check className="w-3.5 h-3.5 mt-1 text-primary shrink-0" />
                  <span>Credits never expire</span>
                </li>
              </ul>
              <Button
                className="w-full"
                onClick={() => checkout.mutate(pkg)}
                disabled={checkout.isPending}
                variant={pkg.popular ? "default" : "outline"}
                data-testid={`button-buy-${pkg.id}`}
              >
                {checkout.isPending ? (
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                ) : null}
                {providerInfo?.is_preview ? "Buy (preview)" : "Buy"} {pkg.credits} credit
                {pkg.credits === 1 ? "" : "s"}
              </Button>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Promo */}
      <Card data-testid="card-promo-code">
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Gift className="w-4 h-4 text-primary" />
            Promo code
          </CardTitle>
          <CardDescription>
            Have a promo code? Enter it below to redeem.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid sm:grid-cols-[1fr_auto] gap-3 items-end max-w-xl">
            <div className="space-y-1.5">
              <Label htmlFor="promo_code">Code</Label>
              <Input
                id="promo_code"
                value={promoCode}
                onChange={(e) => setPromoCode(e.target.value)}
                placeholder="Enter your code"
                autoCapitalize="characters"
                spellCheck={false}
                autoComplete="off"
                data-testid="input-promo-code"
              />
            </div>
            <Button
              onClick={() => redeemPromo.mutate()}
              disabled={!promoCode.trim() || redeemPromo.isPending}
              data-testid="button-redeem-promo"
            >
              {redeemPromo.isPending ? (
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              ) : (
                <Gift className="w-4 h-4 mr-2" />
              )}
              Redeem
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Transaction history */}
      <Card data-testid="card-transaction-history">
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Receipt className="w-4 h-4 text-primary" />
            Transaction history
          </CardTitle>
          <CardDescription>
            Every purchase, promo grant, unlock spend, and admin adjustment is
            recorded in a permanent ledger. Most recent first.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {transactionsQuery.isLoading ? (
            <div className="text-sm text-muted-foreground py-2">Loading\u2026</div>
          ) : transactions.length === 0 ? (
            <div
              className="text-sm text-muted-foreground py-3"
              data-testid="text-history-empty"
            >
              No credit activity yet. Buy a pack or redeem a promo code to get started.
            </div>
          ) : (
            <ul className="divide-y divide-border" data-testid="list-transactions">
              {transactions.map((tx) => (
                <TransactionRow key={tx.id} tx={tx} />
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {providerInfo?.is_preview && (
        <Card>
          <CardContent className="py-4 flex items-start gap-2 text-xs text-muted-foreground">
            <ShieldCheck className="w-4 h-4 mt-0.5 text-primary shrink-0" />
            <p>
              <strong>Preview build:</strong> the payments layer is provider-agnostic
              (<code>PaymentProvider</code> in <code>server/payments.ts</code>) and ships with a
              preview/test provider that does not move real money. To go live, set
              <code> PAYMENT_PROVIDER</code> to a real provider (Stripe Checkout is
              recommended for simple digital credit packs; Lemon Squeezy or Paddle
              are strong drop-in alternatives if you need merchant-of-record VAT
              handling), then wire the SDK call inside the matching class.
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function TransactionRow({ tx }: { tx: CreditTransaction }) {
  const positive = tx.amount_delta > 0;
  const meta = describeTransaction(tx);
  return (
    <li
      className="flex items-center gap-3 py-3"
      data-testid={`row-transaction-${tx.id}`}
    >
      <div
        className={`h-8 w-8 rounded-full grid place-items-center ${
          positive
            ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
            : "bg-amber-500/10 text-amber-700 dark:text-amber-300"
        }`}
        aria-hidden="true"
      >
        {positive ? (
          <ArrowUpRight className="w-4 h-4" />
        ) : (
          <ArrowDownRight className="w-4 h-4" />
        )}
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium" data-testid={`text-tx-title-${tx.id}`}>
          {meta.title}
        </div>
        <div className="text-xs text-muted-foreground truncate">
          {formatDateTime(tx.created_at)}
          {meta.subtitle ? ` \u00b7 ${meta.subtitle}` : ""}
        </div>
      </div>
      <div className="text-right">
        <div
          className={`text-sm font-semibold tabular-nums ${
            positive ? "text-emerald-700 dark:text-emerald-300" : "text-foreground"
          }`}
          data-testid={`text-tx-delta-${tx.id}`}
        >
          {positive ? "+" : ""}
          {tx.amount_delta} credit{Math.abs(tx.amount_delta) === 1 ? "" : "s"}
        </div>
        <div className="text-[11px] text-muted-foreground tabular-nums">
          Balance: {tx.balance_after}
        </div>
      </div>
    </li>
  );
}

function describeTransaction(tx: CreditTransaction): { title: string; subtitle?: string } {
  switch (tx.reason) {
    case "purchase": {
      const providerLabel = tx.provider === "preview"
        ? "Preview checkout"
        : tx.provider
          ? tx.provider.charAt(0).toUpperCase() + tx.provider.slice(1)
          : "Purchase";
      return {
        title: `Credit pack purchase`,
        subtitle: `${providerLabel}${tx.reference ? ` \u00b7 ${tx.reference}` : ""}`,
      };
    }
    case "promo":
      return { title: "Promo code redeemed", subtitle: "Free credits" };
    case "unlock_spend": {
      const m = tx.reference?.match(/analysis:(\d+)/);
      return {
        title: "Report unlock",
        subtitle: m ? `Analysis #${m[1]}` : "Unlocked a locked report",
      };
    }
    case "admin_adjustment":
      return { title: "Admin adjustment", subtitle: tx.reference ?? undefined };
    default:
      return { title: tx.reason, subtitle: tx.reference ?? undefined };
  }
}

function formatDateTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}
