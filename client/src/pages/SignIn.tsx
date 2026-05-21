import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Logo } from "@/components/Logo";
import { Loader2, LogIn, UserPlus, ArrowRight, KeyRound, MailQuestion, ShieldCheck } from "lucide-react";
import type { User, Analysis } from "@shared/schema";
import { track, identify, EVENTS } from "@/lib/analytics";
import {
  readAnonPreviewToken,
  clearAnonPreviewToken,
  setJustClaimedAnalysisId,
} from "@/lib/anonPreview";

/* If the visitor generated an anonymous preview before signing in, the
 * opaque token is in localStorage. After auth we POST it to the claim
 * endpoint so the freshly generated AI report is saved into the user's
 * account WITHOUT re-running the analysis. The resulting analysis id
 * is stashed in sessionStorage for the Analyze page to pick up on
 * mount, so the user lands directly inside their saved (locked)
 * report. Failures here are non-fatal — the user still ends up in the
 * dashboard; they'd just need to run a fresh analysis. */
async function claimAnonymousPreviewIfPresent(): Promise<void> {
  const token = readAnonPreviewToken();
  if (!token) return;
  try {
    const res = await apiRequest("POST", `/api/preview/${encodeURIComponent(token)}/claim`);
    const analysis = (await res.json()) as Analysis;
    if (analysis && typeof analysis.id === "number") {
      setJustClaimedAnalysisId(analysis.id);
      track(EVENTS.anonymous_preview_claimed, {
        analysis_id: analysis.id,
        locked: !!analysis.is_locked,
      });
    }
  } catch {
    /* token expired or already claimed — silently ignore */
  } finally {
    clearAnonPreviewToken();
  }
}

/**
 * Unauthenticated landing screen. Shown whenever /api/me returns 401
 * (no active session). Lets a returning visitor sign in with email +
 * password or a first-time visitor create a new account. After either
 * succeeds the cached /api/me query is invalidated, the user is
 * re-fetched, and the shell automatically transitions to the
 * authenticated UI.
 *
 * Password rules (enforced on both client and server):
 *   - At least 8 characters
 *   - Contains at least one letter and one number
 *
 * If sign-in is attempted against an existing account that has no
 * password stored yet, the server returns 409 with `needs_password_setup`
 * and this screen transitions into a one-time "set a password" panel.
 */
export default function SignIn() {
  // wouter is mounted with the hash-location hook in App.tsx, so this
  // setLocation manipulates the hash route. We call it explicitly after
  // every successful auth mutation so the URL leaves "/signin" and the
  // authenticated shell mounts the Analyze dashboard — the SignIn page
  // must NOT rely solely on the AppRouter guard to redirect, because if
  // the location stays on "/signin" the signed-in branch falls through
  // to ShellRoutes' NotFound. This is the "404 after login" fix.
  const [, navigate] = useLocation();
  const goToDashboard = () => {
    try {
      navigate("/");
    } catch {
      // Belt-and-suspenders: even if wouter throws (e.g. during teardown
      // of the SignIn tree) the hard hash assignment will trigger the
      // hashchange listener and AppRouter will re-evaluate.
    }
    if (typeof window !== "undefined" && window.location.hash !== "#/") {
      window.location.hash = "#/";
    }
  };

  // If the visitor just generated an anonymous preview, default the
  // auth screen to "Create account" — that's the more common next
  // step coming from the preview funnel.
  const hasPendingPreview = typeof window !== "undefined" && !!readAnonPreviewToken();
  const [mode, setMode] = useState<"signin" | "signup">(hasPendingPreview ? "signup" : "signin");
  const [signInEmail, setSignInEmail] = useState("");
  const [signInPassword, setSignInPassword] = useState("");
  const [signUpName, setSignUpName] = useState("");
  const [signUpEmail, setSignUpEmail] = useState("");
  const [signUpPassword, setSignUpPassword] = useState("");
  const [signUpConfirm, setSignUpConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);

  // First-time password setup state. Activated when /api/me/signin
  // returns 409 with needs_password_setup=true. We capture the email
  // the user just typed so they don't have to retype it.
  const [setupEmail, setSetupEmail] = useState<string | null>(null);
  const [setupPassword, setSetupPassword] = useState("");
  const [setupConfirm, setSetupConfirm] = useState("");

  // Forgot-password / reset flow state.
  // step "request": user enters email; we POST /api/me/forgot-password.
  // step "verify":  email accepted; user enters reset code + new password.
  // null:           reset UI hidden (default Sign In / Create account screen).
  const [resetStep, setResetStep] = useState<"request" | "verify" | null>(null);
  const [resetEmail, setResetEmail] = useState("");
  const [resetCode, setResetCode] = useState("");
  const [resetPassword, setResetPassword] = useState("");
  const [resetConfirm, setResetConfirm] = useState("");
  const [resetNotice, setResetNotice] = useState<string | null>(null);
  // Plaintext code returned by the preview-only dev affordance. The
  // server only includes it in dev / when ALLOW_PREVIEW_RESET_CODE=1.
  // Rendered behind a clearly labeled "preview only" banner so a real
  // production deployment that ships with the affordance disabled
  // simply never shows this UI.
  const [previewCode, setPreviewCode] = useState<string | null>(null);

  const signIn = useMutation({
    mutationFn: async (input: { email: string; password: string }) => {
      const res = await apiRequest("POST", "/api/me/signin", input);
      return (await res.json()) as User;
    },
    onSuccess: async (user) => {
      setError(null);
      setSignInPassword("");
      if (user?.id != null) identify(user.id);
      track(EVENTS.signin_completed);
      const hadPendingPreview = !!readAnonPreviewToken();
      await claimAnonymousPreviewIfPresent();
      if (hadPendingPreview) track(EVENTS.signup_after_preview, { mode: "signin" });
      await queryClient.invalidateQueries();
      goToDashboard();
    },
    onError: (e: Error) => {
      const parsed = parseApiError(e);
      if (parsed.needs_password_setup) {
        setError(null);
        setSetupEmail(signInEmail.trim().toLowerCase());
        setSetupPassword("");
        setSetupConfirm("");
        return;
      }
      setError(parsed.message);
    },
  });

  const signUp = useMutation({
    mutationFn: async (input: {
      full_name: string;
      email: string;
      password: string;
      confirm_password: string;
    }) => {
      track(EVENTS.signup_started);
      const res = await apiRequest("POST", "/api/me/signup", input);
      return (await res.json()) as User;
    },
    onSuccess: async (user) => {
      setError(null);
      setSignUpPassword("");
      setSignUpConfirm("");
      if (user?.id != null) identify(user.id);
      track(EVENTS.signup_completed);
      const hadPendingPreview = !!readAnonPreviewToken();
      await claimAnonymousPreviewIfPresent();
      if (hadPendingPreview) track(EVENTS.signup_after_preview, { mode: "signup" });
      await queryClient.invalidateQueries();
      goToDashboard();
    },
    onError: (e: Error) => setError(parseApiError(e).message),
  });

  const forgotPassword = useMutation({
    mutationFn: async (input: { email: string }) => {
      const res = await apiRequest("POST", "/api/me/forgot-password", input);
      return (await res.json()) as { ok: true; message: string; preview_code?: string };
    },
    onSuccess: (payload) => {
      setError(null);
      // Always advance to the verify step — the server returns the same
      // generic response for unknown emails, so we don't tell the user
      // whether the address is real.
      setResetStep("verify");
      setResetNotice(payload.message);
      setPreviewCode(payload.preview_code ?? null);
    },
    onError: (e: Error) => setError(parseApiError(e).message),
  });

  const resetPasswordMutation = useMutation({
    mutationFn: async (input: {
      email: string;
      code: string;
      password: string;
      confirm_password: string;
    }) => {
      const res = await apiRequest("POST", "/api/me/reset-password", input);
      return (await res.json()) as User;
    },
    onSuccess: async () => {
      setError(null);
      setResetStep(null);
      setResetEmail("");
      setResetCode("");
      setResetPassword("");
      setResetConfirm("");
      setResetNotice(null);
      setPreviewCode(null);
      await claimAnonymousPreviewIfPresent();
      await queryClient.invalidateQueries();
      goToDashboard();
    },
    onError: (e: Error) => setError(parseApiError(e).message),
  });

  const exitResetFlow = () => {
    setResetStep(null);
    setResetCode("");
    setResetPassword("");
    setResetConfirm("");
    setResetNotice(null);
    setPreviewCode(null);
    setError(null);
  };

  const setPassword = useMutation({
    mutationFn: async (input: {
      email: string;
      password: string;
      confirm_password: string;
    }) => {
      const res = await apiRequest("POST", "/api/me/set-password", input);
      return (await res.json()) as User;
    },
    onSuccess: async () => {
      setError(null);
      setSetupEmail(null);
      setSetupPassword("");
      setSetupConfirm("");
      await claimAnonymousPreviewIfPresent();
      await queryClient.invalidateQueries();
      goToDashboard();
    },
    onError: (e: Error) => setError(parseApiError(e).message),
  });

  const clientValidate = (
    password: string,
    confirm: string,
  ): string | null => {
    if (password.length < 8) return "Password must be at least 8 characters";
    if (!/[A-Za-z]/.test(password) || !/\d/.test(password)) {
      return "Password must contain at least one letter and one number";
    }
    if (password !== confirm) return "Passwords do not match";
    return null;
  };

  if (resetStep) {
    return (
      <div className="min-h-screen bg-background text-foreground grid place-items-center px-4 py-10">
        <div className="w-full max-w-md space-y-6">
          <div className="flex flex-col items-center gap-3 text-center">
            <Logo size={36} />
            <div>
              <h1 className="text-xl font-semibold tracking-tight">
                {resetStep === "request" ? "Reset your password" : "Enter your reset code"}
              </h1>
              <p className="text-sm text-muted-foreground mt-1">
                {resetStep === "request"
                  ? "Enter the email on your account. If it exists, we'll generate a single-use reset code."
                  : "Enter the code you received, then choose a new password."}
              </p>
            </div>
          </div>

          <Card data-testid="card-password-reset">
            <CardHeader className="pb-2">
              <CardTitle className="text-base">
                {resetStep === "request" ? "Forgot password" : "Set a new password"}
              </CardTitle>
              <CardDescription>
                {resetStep === "request"
                  ? "We won't confirm whether the email is registered — that's by design."
                  : resetEmail}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {resetStep === "request" && (
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (!resetEmail.trim()) return;
                    setError(null);
                    forgotPassword.mutate({ email: resetEmail.trim() });
                  }}
                  className="space-y-3"
                >
                  <div className="space-y-1.5">
                    <Label htmlFor="reset-email">Email</Label>
                    <Input
                      id="reset-email"
                      type="email"
                      autoComplete="email"
                      placeholder="you@example.com"
                      value={resetEmail}
                      onChange={(e) => setResetEmail(e.target.value)}
                      data-testid="input-reset-email"
                      required
                    />
                  </div>
                  <Button
                    type="submit"
                    className="w-full"
                    disabled={forgotPassword.isPending || !resetEmail.trim()}
                    data-testid="button-reset-request"
                  >
                    {forgotPassword.isPending ? (
                      <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    ) : (
                      <MailQuestion className="w-4 h-4 mr-2" />
                    )}
                    Send reset code
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    className="w-full"
                    onClick={exitResetFlow}
                    data-testid="button-reset-cancel"
                  >
                    Back to sign in
                  </Button>
                </form>
              )}

              {resetStep === "verify" && (
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (!resetEmail.trim() || !resetCode.trim()) return;
                    const msg = clientValidate(resetPassword, resetConfirm);
                    if (msg) {
                      setError(msg);
                      return;
                    }
                    setError(null);
                    resetPasswordMutation.mutate({
                      email: resetEmail.trim(),
                      code: resetCode.trim(),
                      password: resetPassword,
                      confirm_password: resetConfirm,
                    });
                  }}
                  className="space-y-3"
                >
                  {resetNotice && (
                    <Alert data-testid="alert-reset-notice">
                      <AlertDescription>{resetNotice}</AlertDescription>
                    </Alert>
                  )}
                  {previewCode && (
                    <div
                      className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm"
                      data-testid="banner-preview-reset-code"
                    >
                      <p className="font-semibold text-amber-700 dark:text-amber-300">
                        Preview build — reset code shown only for testing
                      </p>
                      <p className="text-xs text-muted-foreground mt-1">
                        Production builds disable this affordance and email the
                        code to the user instead.
                      </p>
                      <p
                        className="mt-2 font-mono text-lg tracking-widest text-foreground"
                        data-testid="text-preview-reset-code"
                      >
                        {previewCode}
                      </p>
                    </div>
                  )}
                  <div className="space-y-1.5">
                    <Label htmlFor="reset-code">Reset code</Label>
                    <Input
                      id="reset-code"
                      type="text"
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      placeholder="6-digit code"
                      value={resetCode}
                      onChange={(e) => setResetCode(e.target.value)}
                      data-testid="input-reset-code"
                      required
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="reset-password">New password</Label>
                    <Input
                      id="reset-password"
                      type="password"
                      autoComplete="new-password"
                      placeholder="At least 8 characters, with a number"
                      value={resetPassword}
                      onChange={(e) => setResetPassword(e.target.value)}
                      data-testid="input-reset-password"
                      required
                      minLength={8}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="reset-confirm">Confirm new password</Label>
                    <Input
                      id="reset-confirm"
                      type="password"
                      autoComplete="new-password"
                      placeholder="Re-enter your new password"
                      value={resetConfirm}
                      onChange={(e) => setResetConfirm(e.target.value)}
                      data-testid="input-reset-confirm"
                      required
                      minLength={8}
                    />
                  </div>
                  <Button
                    type="submit"
                    className="w-full"
                    disabled={
                      resetPasswordMutation.isPending ||
                      !resetCode.trim() ||
                      !resetPassword ||
                      !resetConfirm
                    }
                    data-testid="button-reset-confirm"
                  >
                    {resetPasswordMutation.isPending ? (
                      <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    ) : (
                      <ShieldCheck className="w-4 h-4 mr-2" />
                    )}
                    Reset password &amp; sign in
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    className="w-full"
                    onClick={exitResetFlow}
                    data-testid="button-reset-verify-cancel"
                  >
                    Cancel
                  </Button>
                </form>
              )}

              {error && (
                <Alert variant="destructive" data-testid="alert-auth-error">
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    );
  }

  if (setupEmail) {
    return (
      <div className="min-h-screen bg-background text-foreground grid place-items-center px-4 py-10">
        <div className="w-full max-w-md space-y-6">
          <div className="flex flex-col items-center gap-3 text-center">
            <Logo size={36} />
            <div>
              <h1 className="text-xl font-semibold tracking-tight">Set a password</h1>
              <p className="text-sm text-muted-foreground mt-1">
                This account doesn't have a password yet. Choose one to continue.
              </p>
            </div>
          </div>

          <Card data-testid="card-password-setup">
            <CardHeader className="pb-2">
              <CardTitle className="text-base">First-time password setup</CardTitle>
              <CardDescription className="break-all">{setupEmail}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  const msg = clientValidate(setupPassword, setupConfirm);
                  if (msg) {
                    setError(msg);
                    return;
                  }
                  setError(null);
                  setPassword.mutate({
                    email: setupEmail,
                    password: setupPassword,
                    confirm_password: setupConfirm,
                  });
                }}
                className="space-y-3"
              >
                <div className="space-y-1.5">
                  <Label htmlFor="setup-password">New password</Label>
                  <Input
                    id="setup-password"
                    type="password"
                    autoComplete="new-password"
                    placeholder="At least 8 characters, with a number"
                    value={setupPassword}
                    onChange={(e) => setSetupPassword(e.target.value)}
                    data-testid="input-setup-password"
                    required
                    minLength={8}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="setup-confirm">Confirm password</Label>
                  <Input
                    id="setup-confirm"
                    type="password"
                    autoComplete="new-password"
                    placeholder="Re-enter your password"
                    value={setupConfirm}
                    onChange={(e) => setSetupConfirm(e.target.value)}
                    data-testid="input-setup-confirm"
                    required
                    minLength={8}
                  />
                </div>
                <Button
                  type="submit"
                  className="w-full"
                  disabled={setPassword.isPending || !setupPassword || !setupConfirm}
                  data-testid="button-setup-password"
                >
                  {setPassword.isPending ? (
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  ) : (
                    <KeyRound className="w-4 h-4 mr-2" />
                  )}
                  Set password &amp; sign in
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  className="w-full"
                  onClick={() => {
                    setSetupEmail(null);
                    setError(null);
                  }}
                  data-testid="button-setup-cancel"
                >
                  Cancel
                </Button>
              </form>

              {error && (
                <Alert variant="destructive" data-testid="alert-auth-error">
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background text-foreground grid place-items-center px-4 py-10">
      <div className="w-full max-w-md space-y-6">
        <div className="flex flex-col items-center gap-3 text-center">
          <Logo size={36} />
          <div>
            <h1 className="text-xl font-semibold tracking-tight">CareerProof AI</h1>
            <p className="text-sm text-muted-foreground mt-1">
              {hasPendingPreview
                ? "Create a free account to save your preview and unlock the full AI Exposure Report. We'll bring you straight back to your saved report — no rerun, nothing to re-enter."
                : "Sign in to your account or create a new one to analyze your role."}
            </p>
          </div>
        </div>

        <Card data-testid="card-auth">
          <CardHeader className="pb-2">
            <CardTitle className="text-base">
              {mode === "signin" ? "Welcome back" : "Create your account"}
            </CardTitle>
            <CardDescription>
              {mode === "signin"
                ? "Enter your email and password to continue."
                : "First-time here? Set up an account in seconds."}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <Tabs value={mode} onValueChange={(v) => { setMode(v as "signin" | "signup"); setError(null); }}>
              <TabsList className="grid grid-cols-2 w-full">
                <TabsTrigger value="signin" data-testid="tab-signin">
                  <LogIn className="w-3.5 h-3.5 mr-1.5" />
                  Sign in
                </TabsTrigger>
                <TabsTrigger value="signup" data-testid="tab-signup">
                  <UserPlus className="w-3.5 h-3.5 mr-1.5" />
                  Create account
                </TabsTrigger>
              </TabsList>

              <TabsContent value="signin" className="pt-4 space-y-3">
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (!signInEmail.trim() || !signInPassword) return;
                    setError(null);
                    signIn.mutate({
                      email: signInEmail.trim(),
                      password: signInPassword,
                    });
                  }}
                  className="space-y-3"
                >
                  <div className="space-y-1.5">
                    <Label htmlFor="signin-email">Email</Label>
                    <Input
                      id="signin-email"
                      type="email"
                      autoComplete="email"
                      placeholder="you@example.com"
                      value={signInEmail}
                      onChange={(e) => setSignInEmail(e.target.value)}
                      data-testid="input-signin-email"
                      required
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="signin-password">Password</Label>
                    <Input
                      id="signin-password"
                      type="password"
                      autoComplete="current-password"
                      placeholder="Your password"
                      value={signInPassword}
                      onChange={(e) => setSignInPassword(e.target.value)}
                      data-testid="input-signin-password"
                      required
                    />
                  </div>
                  <Button
                    type="submit"
                    className="w-full"
                    disabled={signIn.isPending || !signInEmail.trim() || !signInPassword}
                    data-testid="button-signin"
                  >
                    {signIn.isPending ? (
                      <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    ) : (
                      <ArrowRight className="w-4 h-4 mr-2" />
                    )}
                    Sign in
                  </Button>
                  <div className="flex justify-end">
                    <button
                      type="button"
                      className="text-xs text-muted-foreground hover:text-foreground underline-offset-2 hover:underline"
                      onClick={() => {
                        setError(null);
                        setResetEmail(signInEmail.trim());
                        setResetStep("request");
                      }}
                      data-testid="button-forgot-password"
                    >
                      Forgot password?
                    </button>
                  </div>
                </form>
              </TabsContent>

              <TabsContent value="signup" className="pt-4 space-y-3">
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (
                      !signUpName.trim() ||
                      !signUpEmail.trim() ||
                      !signUpPassword ||
                      !signUpConfirm
                    ) {
                      return;
                    }
                    const msg = clientValidate(signUpPassword, signUpConfirm);
                    if (msg) {
                      setError(msg);
                      return;
                    }
                    setError(null);
                    signUp.mutate({
                      full_name: signUpName.trim(),
                      email: signUpEmail.trim(),
                      password: signUpPassword,
                      confirm_password: signUpConfirm,
                    });
                  }}
                  className="space-y-3"
                >
                  <div className="space-y-1.5">
                    <Label htmlFor="signup-name">Full name</Label>
                    <Input
                      id="signup-name"
                      type="text"
                      autoComplete="name"
                      placeholder="Jane Doe"
                      value={signUpName}
                      onChange={(e) => setSignUpName(e.target.value)}
                      data-testid="input-signup-name"
                      required
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="signup-email">Email</Label>
                    <Input
                      id="signup-email"
                      type="email"
                      autoComplete="email"
                      placeholder="you@example.com"
                      value={signUpEmail}
                      onChange={(e) => setSignUpEmail(e.target.value)}
                      data-testid="input-signup-email"
                      required
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="signup-password">Password</Label>
                    <Input
                      id="signup-password"
                      type="password"
                      autoComplete="new-password"
                      placeholder="At least 8 characters, with a number"
                      value={signUpPassword}
                      onChange={(e) => setSignUpPassword(e.target.value)}
                      data-testid="input-signup-password"
                      required
                      minLength={8}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="signup-confirm">Confirm password</Label>
                    <Input
                      id="signup-confirm"
                      type="password"
                      autoComplete="new-password"
                      placeholder="Re-enter your password"
                      value={signUpConfirm}
                      onChange={(e) => setSignUpConfirm(e.target.value)}
                      data-testid="input-signup-confirm"
                      required
                      minLength={8}
                    />
                  </div>
                  <Button
                    type="submit"
                    className="w-full"
                    disabled={
                      signUp.isPending ||
                      !signUpName.trim() ||
                      !signUpEmail.trim() ||
                      !signUpPassword ||
                      !signUpConfirm
                    }
                    data-testid="button-signup"
                  >
                    {signUp.isPending ? (
                      <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    ) : (
                      <UserPlus className="w-4 h-4 mr-2" />
                    )}
                    Create account
                  </Button>
                  <p className="text-[11px] text-muted-foreground">
                    New accounts start with zero credits — you'll see a locked preview until you buy credits or redeem a promo code.
                  </p>
                </form>
              </TabsContent>
            </Tabs>

            {error && (
              <Alert variant="destructive" data-testid="alert-auth-error">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

/**
 * apiRequest throws `Error("<status>: <body>")`. Peel the body, attempt
 * to parse JSON, and return a structured {message, needs_password_setup}
 * so the caller can branch on the password-setup signal.
 */
function parseApiError(err: Error): { message: string; needs_password_setup?: boolean } {
  const message = err.message ?? "Something went wrong.";
  const match = message.match(/^\d+:\s*(.*)$/);
  const payload = match ? match[1] : message;
  try {
    const parsed = JSON.parse(payload);
    if (parsed && typeof parsed === "object") {
      const msg = typeof parsed.error === "string" ? parsed.error : payload;
      return {
        message: msg || "Something went wrong.",
        needs_password_setup: !!parsed.needs_password_setup,
      };
    }
  } catch {
    // not JSON; fall through
  }
  return { message: payload || "Something went wrong." };
}
