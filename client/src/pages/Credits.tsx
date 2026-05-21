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
  Lock,
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
import type { Analysis, CreditTransaction } from "@shared/schema";
import { track, EVENTS } from "@/lib/analytics";
import {
  clearPendingUnlockAnalysisId,
  getPendingUnlockAnalysisId,
} from "@/lib/pendingUnlock";

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
  /* Live providers (Stripe): the redirect handler does NOT grant
   * credits — the webhook is authoritative. When `pending` is true,
   * the buyer just returned from the provider and the webhook may not
   * have fired yet. The client should poll /api/me + ledger until
   * the new balance appears, then surface success. */
  pending?: boolean;
  provider?: string;
  package?: CreditPackage;
}

export default function Credits() {
  const { data: me } = useMe();
  const { toast } = useToast();
  const [location, setLocation] = useLocation();
  const [promoCode, setPromoCode] = useState("");
  const [completionStatus, setCompletionStatus] = useState<
    | { kind: "success"; credits: number; already: boolean }
    | { kind: "cancel" }
    | { kind: "error"; message: string }
    | { kind: "pending"; provider: string }
    | null
  >(null);
  /* Tracks the Stripe checkout session id we're currently polling for
   * webhook fulfillment. Cleared once the new ledger row arrives or
   * the user navigates away. The id alone is not sensitive (it lands
   * in the URL on redirect anyway) and clears on refresh. */
  const [pendingStripeSession, setPendingStripeSession] = useState<string | null>(null);
  const unlimitedCredits = hasUnlimitedCredits(me?.email, me?.role);

  /* Auto-unlock-after-purchase state.
   *
   * When the user lands on /credits after clicking "Buy credits to
   * unlock" from a locked report, we remember the target analysis id in
   * localStorage (see lib/pendingUnlock.ts). The id is read once on
   * mount; the Credits page surfaces a banner explaining what will
   * happen, and the moment a purchase completes (preview inline grant,
   * or Stripe webhook ledger row arrives) we POST
   * /api/analyses/:id/unlock and navigate the user straight to the
   * full report. The id is cleared as soon as the unlock attempt
   * resolves so a stale pending id can never auto-unlock an unrelated
   * future purchase. */
  const [pendingUnlockId, setPendingUnlockId] = useState<number | null>(null);
  const [unlockAttempted, setUnlockAttempted] = useState(false);
  useEffect(() => {
    setPendingUnlockId(getPendingUnlockAnalysisId());
  }, []);

  const unlockAfterPurchase = useMutation({
    mutationFn: async (analysisId: number) => {
      const res = await apiRequest("POST", `/api/analyses/${analysisId}/unlock`);
      return (await res.json()) as Analysis;
    },
    onSuccess: async (updated) => {
      clearPendingUnlockAnalysisId();
      await queryClient.invalidateQueries({ queryKey: ["/api/me"] });
      await queryClient.invalidateQueries({ queryKey: ["/api/credits/transactions"] });
      await queryClient.invalidateQueries({ queryKey: ["/api/analyses"] });
      queryClient.setQueryData(["/api/analyses", updated.id], updated);
      toast({
        title: "Report unlocked",
        description: "Taking you back to your full report…",
      });
      /* Defer the navigation a tick so the toast has a chance to render
       * before the route changes. Wouter is hash-based so this is a
       * pure client-side transition — no full reload. */
      setTimeout(() => {
        setLocation(`/report/${updated.id}`);
      }, 300);
    },
    onError: (err: any) => {
      /* The most likely failure is "insufficient_credits" if a Stripe
       * webhook hasn't actually landed yet despite the success status
       * — we leave the pending id in place so the next ledger refresh
       * can retry, and surface a non-destructive toast. Any other error
       * clears the pending id so the user is not stuck in an auto-retry
       * loop. */
      const raw = String(err?.message ?? "");
      const insufficient =
        raw.startsWith("402") ||
        raw.includes("insufficient_credits") ||
        raw.includes("don’t have any credits");
      if (!insufficient) {
        clearPendingUnlockAnalysisId();
        setPendingUnlockId(null);
        toast({
          title: "Unable to unlock the report automatically",
          description:
            "Your credits are on your account. Open the report from History and click Unlock to apply one.",
          variant: "destructive",
        });
      }
    },
  });

  /* Fire auto-unlock as soon as both conditions hold:
   *   1. The user has a pending unlock target stashed.
   *   2. A purchase has just completed successfully (kind === "success"
   *      and `already` === false means a credit was just granted).
   * Also re-fire when `already === true` so re-landing after a previous
   * grant still resolves the locked report. We guard with
   * `unlockAttempted` so the mutation runs at most once per page load. */
  useEffect(() => {
    if (unlockAttempted) return;
    if (!pendingUnlockId) return;
    if (completionStatus?.kind !== "success") return;
    if (unlockAfterPurchase.isPending) return;
    setUnlockAttempted(true);
    unlockAfterPurchase.mutate(pendingUnlockId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [completionStatus, pendingUnlockId, unlockAttempted]);

  /* Unlimited-credit users (admins or entitled emails) who hit /credits
   * with a pending unlock target should also be sent straight back —
   * unlocking is free for them and there is no purchase step. */
  useEffect(() => {
    if (unlockAttempted) return;
    if (!pendingUnlockId) return;
    if (!unlimitedCredits) return;
    if (unlockAfterPurchase.isPending) return;
    setUnlockAttempted(true);
    unlockAfterPurchase.mutate(pendingUnlockId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unlimitedCredits, pendingUnlockId, unlockAttempted]);

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
      /* Stripe path: complete-checkout returns `pending: true` when
       * the webhook has not yet fulfilled the session. Keep the
       * "pending" status so the poller can flip to success when the
       * ledger row appears. If the webhook already fired and the
       * ledger has the purchase row, complete-checkout returns
       * `already_processed: true`; we surface success either way. */
      if (data.pending) {
        setCompletionStatus({ kind: "pending", provider: data.provider ?? "stripe" });
      } else {
        const credits =
          data.credits_added > 0 ? data.credits_added : data.package?.credits ?? 0;
        setCompletionStatus({
          kind: "success",
          credits,
          already: data.already_processed,
        });
        if (!data.already_processed) {
          track(EVENTS.checkout_success, {
            provider: data.provider ?? "preview",
            credits_added: credits,
            package_id: data.package?.id,
            value: data.package ? data.package.price_cents / 100 : undefined,
            currency: data.package?.currency ?? "USD",
          });
        }
        if (data.already_processed) {
          setPendingStripeSession(null);
        }
      }
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
    } else if (status === "preview-cancel" || status === "stripe-cancel") {
      setCompletionStatus({ kind: "cancel" });
    } else if (status === "stripe-success") {
      /* Stripe redirected the buyer back. The webhook is the
       * authoritative grant path; we trigger a single complete-checkout
       * call so the server can tell us whether the webhook has
       * already fired, and then we start polling /api/me + ledger
       * until the new balance appears. */
      const session_id = callbackParams.get("session_id") ?? "";
      if (session_id) {
        setPendingStripeSession(session_id);
        setCompletionStatus({ kind: "pending", provider: "stripe" });
        if (!completeCheckout.isPending) {
          completeCheckout.mutate({ session_id, token: "" });
        }
      }
    }
    clearPaymentCallbackParams();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [callbackParams]);

  /* Stripe pending-state poller. While `pendingStripeSession` is set,
   * we refetch /api/me and /api/credits/transactions every 2 seconds.
   * As soon as the ledger contains a row keyed by this Stripe session,
   * we flip the status to success and stop polling. Bounded at 60s
   * (30 polls) to avoid an infinite spinner if the webhook never
   * fires — the user sees a clear "taking longer than expected" message. */
  useEffect(() => {
    if (!pendingStripeSession) return;
    let polls = 0;
    const maxPolls = 30;
    const id = window.setInterval(() => {
      polls += 1;
      queryClient.invalidateQueries({ queryKey: ["/api/me"] });
      queryClient.invalidateQueries({ queryKey: ["/api/credits/transactions"] });
      if (polls >= maxPolls) {
        window.clearInterval(id);
        setCompletionStatus({
          kind: "error",
          message:
            "Stripe confirmed payment but the credit grant is taking longer than expected. Your credits will appear in transaction history once Stripe finishes processing.",
        });
        setPendingStripeSession(null);
      }
    }, 2000);
    return () => window.clearInterval(id);
  }, [pendingStripeSession]);

  /* When the polling ledger query refreshes, look for the row that
   * matches the pending Stripe session and resolve the completion. */
  useEffect(() => {
    if (!pendingStripeSession) return;
    const txs = transactionsQuery.data?.transactions ?? [];
    const ref = `stripe:checkout_session:${pendingStripeSession}`;
    const match = txs.find((t) => t.reference === ref && t.reason === "purchase");
    if (match) {
      setCompletionStatus({ kind: "success", credits: match.amount_delta, already: false });
      track(EVENTS.checkout_success, {
        provider: "stripe",
        credits_added: match.amount_delta,
      });
      setPendingStripeSession(null);
    }
  }, [pendingStripeSession, transactionsQuery.data]);

  const checkout = useMutation({
    mutationFn: async (pkg: CreditPackage) => {
      track(EVENTS.checkout_started, {
        package_id: pkg.id,
        credits: pkg.credits,
        value: pkg.price_cents / 100,
        currency: pkg.currency || "USD",
      });
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
          <h1 className="text-xl font-semibold tracking-tight">Unlock the full AI Exposure Report</h1>
          <p className="text-sm text-muted-foreground">
            One credit unlocks one full report. The free preview shows your score and a short summary —
            credits unlock the detailed task breakdown, skills to build, action plan, and PDF export.{" "}
            {pendingUnlockId
              ? "We'll automatically use one credit on your existing locked report (no rerun)."
              : null}
            {" "}
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

      {pendingUnlockId && !completionStatus && !unlockAfterPurchase.isPending && (
        <Alert
          data-testid="alert-pending-unlock"
          className="border-cyan-500/30 bg-cyan-500/10"
        >
          <Lock className="w-4 h-4" />
          <AlertTitle>Buying a credit will unlock your locked report</AlertTitle>
          <AlertDescription>
            Your preview report is saved. After checkout completes we'll
            automatically use one credit to unlock report&nbsp;#{pendingUnlockId}
            {" "}and bring you straight back to it — you won't need to rerun
            the analysis.
          </AlertDescription>
        </Alert>
      )}

      {unlockAfterPurchase.isPending && (
        <Alert
          data-testid="alert-auto-unlocking"
          className="border-emerald-500/30 bg-emerald-500/10"
        >
          <Loader2 className="w-4 h-4 animate-spin" />
          <AlertTitle>Unlocking your report…</AlertTitle>
          <AlertDescription>
            Applying one credit to your existing locked report. You'll be
            taken back to the full report in a moment.
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
      {completionStatus?.kind === "pending" && (
        <Alert data-testid="alert-payment-pending" className="border-amber-500/30 bg-amber-500/10">
          <Loader2 className="w-4 h-4 animate-spin" />
          <AlertTitle>Finishing your purchase…</AlertTitle>
          <AlertDescription>
            Stripe confirmed payment. Waiting for the credit grant to land in your
            account (usually a few seconds). This page will update automatically.
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

      <p className="text-xs text-muted-foreground" data-testid="text-trust">
        No subscription required · One credit = one full report · Secure checkout powered by Stripe ·
        Directional career-risk insight, not a guarantee.
      </p>

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
                onClick={() => {
                  track(EVENTS.buy_credits_clicked, {
                    source: "credits_page",
                    package_id: pkg.id,
                    credits: pkg.credits,
                  });
                  checkout.mutate(pkg);
                }}
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
