import { Switch, Route, Router, useLocation } from "wouter";
import { useHashLocation } from "wouter/use-hash-location";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/not-found";
import Analyze from "@/pages/Analyze";
import AnonymousAnalyze from "@/pages/AnonymousAnalyze";
import History from "@/pages/History";
import Resumes from "@/pages/Resumes";
import Credits from "@/pages/Credits";
import Profile from "@/pages/Profile";
import Admin from "@/pages/Admin";
import Report from "@/pages/Report";
import SignIn from "@/pages/SignIn";
import Landing from "@/pages/Landing";
import SampleReport from "@/pages/SampleReport";
import { AppLayout } from "@/components/AppLayout";
import { useEffect } from "react";
import { useMe } from "@/hooks/useMe";
import { Skeleton } from "@/components/ui/skeleton";

function ThemeProvider({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    // This app is intentionally dark-only. We do NOT read prefers-color-scheme
    // and we do NOT persist a user choice (no localStorage / cookies in the
    // sandbox). The inline bootstrap in index.html already added .dark on the
    // first paint; we re-assert it here so HMR, route changes, or any third
    // party script that tampers with the class list cannot revert the app to
    // light mode.
    document.documentElement.classList.add("dark");
    document.documentElement.style.colorScheme = "dark";
  }, []);
  return <>{children}</>;
}

function ShellRoutes() {
  return (
    <AppLayout>
      <Switch>
        <Route path="/" component={Analyze} />
        {/* Fail-safe aliases: when a signed-in user lands on an auth-only
         * route (because the SignIn redirect didn't fire, the browser
         * restored the URL, etc.) we still render the Analyze dashboard
         * instead of falling through to NotFound. */}
        <Route path="/analyze" component={Analyze} />
        <Route path="/signin" component={Analyze} />
        <Route path="/login" component={Analyze} />
        <Route path="/signup" component={Analyze} />
        <Route path="/history" component={History} />
        <Route path="/resumes" component={Resumes} />
        <Route path="/credits" component={Credits} />
        <Route path="/profile" component={Profile} />
        <Route path="/admin" component={Admin} />
        <Route path="/sample-report" component={SampleReport} />
        <Route component={NotFound} />
      </Switch>
    </AppLayout>
  );
}

/* Routes that exist only for unauthenticated visitors. When a signed-in
 * user is sitting on one of these (e.g. because they were on /signin
 * when the session was established and the URL never moved), we rewrite
 * the hash so wouter matches /. This is the primary fail-safe against
 * the "404 after login" bug. */
const AUTH_ONLY_PATHS = new Set(["/signin", "/login", "/signup"]);

function AuthLoading() {
  return (
    <div className="min-h-screen bg-background grid place-items-center p-6">
      <div className="w-full max-w-md space-y-3">
        <Skeleton className="h-10 w-40 mx-auto" />
        <Skeleton className="h-64 w-full" />
      </div>
    </div>
  );
}

/* Defensive: when a provider redirect lands at the app with
 *   `https://app/?status=...&session_id=...&token=...#/credits`
 * (or the older `#/credits?status=...` form where the query is glued
 * onto the hash), we capture the verification fields, strip them from
 * the URL so wouter's `/credits` route can match cleanly, and let the
 * Credits page complete the purchase on mount.
 *
 * The strip is critical: wouter's parser (regexparam, strict-match)
 * does NOT treat the chars after `?` as a separate search string when
 * they live inside the hash, so `/credits?status=foo` doesn't match
 * the `/credits` route and the page falls through to NotFound.
 *
 * We stash the captured params on globalThis under a private symbol
 * so the Credits page can read them after it mounts. This is
 * intentionally NOT localStorage — the value must NOT survive a
 * page refresh once we've cleaned the URL. */
const PAYMENT_CALLBACK_KEY = Symbol.for("careerproof.payment.callback");
export function readPaymentCallbackParams(): URLSearchParams | null {
  const g = globalThis as any;
  const v = g[PAYMENT_CALLBACK_KEY] as URLSearchParams | undefined;
  return v ?? null;
}
export function clearPaymentCallbackParams(): void {
  (globalThis as any)[PAYMENT_CALLBACK_KEY] = undefined;
}

function useNormalizePaymentCallback() {
  useEffect(() => {
    let captured: URLSearchParams | null = null;
    // 1. From location.search (live-provider redirect target).
    const search = window.location.search.replace(/^\?/, "");
    if (search && /(^|&)status=/.test(search)) {
      captured = new URLSearchParams(search);
    }
    // 2. From the hash fragment when the provider stitched the query
    //    onto the hash (`#/credits?status=...`). Older preview tokens
    //    used this form.
    const hash = window.location.hash;
    if (!captured && hash.includes("?")) {
      const q = hash.split("?").slice(1).join("?");
      if (/(^|&)status=/.test(q)) captured = new URLSearchParams(q);
    }
    if (!captured) return;
    const status = captured.get("status");
    if (
      status !== "preview-success" &&
      status !== "preview-cancel" &&
      status !== "stripe-success" &&
      status !== "stripe-cancel"
    ) {
      return;
    }

    // Stash for the Credits page to pick up.
    (globalThis as any)[PAYMENT_CALLBACK_KEY] = captured;

    // Rebuild the URL with a clean hash route so wouter matches
    // `/credits` exactly and the Credits page mounts.
    const cleanUrl = `${window.location.pathname}#/credits`;
    window.history.replaceState(null, "", cleanUrl);
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  }, []);
}

function AppRouter() {
  const [location, setLocation] = useLocation();
  const { data: me, isLoading, isFetching } = useMe();
  useNormalizePaymentCallback();

  // While the very first /api/me round-trip is in flight, show a neutral
  // loading state. This avoids briefly flashing either the signed-in UI
  // or the sign-in screen during boot or after a logout-triggered refetch.
  if (isLoading || (me === undefined && isFetching)) {
    return <AuthLoading />;
  }

  // No session → public surfaces:
  //   /            → marketing landing page
  //   /analyze     → anonymous AI job-risk preview flow (NEW)
  //   /signin      → sign-in / create-account (preserves preview ?token)
  //   /sample-report
  // Everything else gets normalized back to `/` so protected pages
  // cannot render with stale signed-in UI after sign-out.
  if (!me) {
    if (location === "/signin") {
      return <SignIn />;
    }
    if (location === "/sample-report") {
      return <SampleReport />;
    }
    if (location === "/analyze") {
      return <AnonymousAnalyze />;
    }
    if (location !== "/") {
      // Normalize the hash so the URL reflects the unauthenticated state.
      // Wrapped in a microtask so we don't update during render.
      queueMicrotask(() => setLocation("/"));
    }
    return <Landing />;
  }

  // Signed in but URL is still on an auth-only screen — rewrite to "/"
  // so the dashboard mounts. This is the second fail-safe (in addition
  // to the SignIn mutation success handlers calling setLocation("/"))
  // against the "404 after login" bug.
  if (AUTH_ONLY_PATHS.has(location)) {
    queueMicrotask(() => setLocation("/"));
    return <AuthLoading />;
  }

  // The report page renders standalone (no sidebar, print-friendly).
  if (location.startsWith("/report/")) {
    return (
      <Switch>
        <Route path="/report/:id" component={Report} />
      </Switch>
    );
  }
  return <ShellRoutes />;
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <TooltipProvider>
          <Toaster />
          <Router hook={useHashLocation}>
            <AppRouter />
          </Router>
        </TooltipProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}

export default App;
