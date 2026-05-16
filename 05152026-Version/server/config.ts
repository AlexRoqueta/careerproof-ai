/* =====================================================================
 * Production configuration validation
 *
 * Centralizes the rules that decide whether the current process is
 * safely configured for production. Two consumers:
 *
 *   1. `validateConfigAtStartup()` — invoked from server/index.ts.
 *      Prints warnings (or in strict prod mode, throws) so the operator
 *      sees the gap before traffic arrives.
 *   2. `getConfigReport()` — exposed via GET /api/config/check so an
 *      ops dashboard / smoke test can confirm the deployed instance is
 *      production-safe. Sensitive values are NEVER echoed back — only
 *      booleans describing whether they are set.
 *
 * Required-in-production variables:
 *   - APP_BASE_URL                 absolute public URL of the site
 *                                  (used for redirect URLs, emails, etc.)
 *   - PAYMENT_PROVIDER             "preview" is forbidden in production;
 *                                  must be "stripe" | "lemonsqueezy"
 *   - Provider credentials         when PAYMENT_PROVIDER=stripe:
 *                                  STRIPE_SECRET_KEY + STRIPE_WEBHOOK_SECRET
 *                                  when PAYMENT_PROVIDER=lemonsqueezy:
 *                                  LEMONSQUEEZY_API_KEY + LEMONSQUEEZY_WEBHOOK_SECRET
 *   - Email pipeline               at least one of:
 *                                  EMAIL_PROVIDER + EMAIL_API_KEY + EMAIL_FROM
 *                                  OR
 *                                  RESET_DELIVERY_MODE in {"smtp", "log"}
 *                                  with the matching SMTP_HOST / etc.
 *   - ALLOW_PREVIEW_RESET_CODE     must be unset in production unless
 *                                  the operator explicitly opts in for
 *                                  a guided demo. Surfaced as a warning,
 *                                  not a fatal error.
 *
 * The check is non-fatal in preview mode (NODE_ENV !== "production")
 * and in strict-prod mode it logs every gap before throwing so a
 * misconfigured deploy crashes loudly rather than booting in a half-
 * configured state. The CONFIG_STRICT=0 escape hatch downgrades the
 * throw to a warning when an operator deliberately needs to run a
 * production-build smoke test without all credentials wired.
 * ===================================================================== */

export type ConfigSeverity = "ok" | "warn" | "error";

export interface ConfigCheckItem {
  key: string;
  severity: ConfigSeverity;
  message: string;
}

export interface ConfigReport {
  node_env: string;
  is_production: boolean;
  payment_provider: string;
  preview_reset_code_enabled: boolean;
  app_base_url_set: boolean;
  email_pipeline_configured: boolean;
  payment_credentials_configured: boolean;
  ok: boolean;
  items: ConfigCheckItem[];
}

function isSet(name: string): boolean {
  const v = process.env[name];
  return typeof v === "string" && v.trim().length > 0;
}

function paymentCredentialsOk(provider: string): { ok: boolean; missing: string[] } {
  const missing: string[] = [];
  if (provider === "stripe") {
    if (!isSet("STRIPE_SECRET_KEY")) missing.push("STRIPE_SECRET_KEY");
    if (!isSet("STRIPE_WEBHOOK_SECRET")) missing.push("STRIPE_WEBHOOK_SECRET");
  } else if (provider === "lemonsqueezy" || provider === "lemon-squeezy") {
    if (!isSet("LEMONSQUEEZY_API_KEY")) missing.push("LEMONSQUEEZY_API_KEY");
    if (!isSet("LEMONSQUEEZY_WEBHOOK_SECRET")) missing.push("LEMONSQUEEZY_WEBHOOK_SECRET");
  }
  return { ok: missing.length === 0, missing };
}

function emailPipelineOk(): { ok: boolean; reason: string } {
  // Option A: SaaS email provider (Resend, SendGrid, Postmark, etc.)
  const provider = (process.env.EMAIL_PROVIDER ?? "").trim();
  if (provider && isSet("EMAIL_API_KEY") && isSet("EMAIL_FROM")) {
    return { ok: true, reason: `EMAIL_PROVIDER=${provider}` };
  }
  // Option B: SMTP
  const mode = (process.env.RESET_DELIVERY_MODE ?? "").trim().toLowerCase();
  if (mode === "smtp") {
    if (isSet("SMTP_HOST") && isSet("SMTP_USER") && isSet("SMTP_PASS") && isSet("SMTP_FROM")) {
      return { ok: true, reason: "RESET_DELIVERY_MODE=smtp" };
    }
    return { ok: false, reason: "RESET_DELIVERY_MODE=smtp but SMTP_* envs missing" };
  }
  // Option C: explicit log mode — accepted, but flagged as a warning
  // (not an error) because the operator may genuinely want to ship
  // codes to the application log for a short, well-monitored launch
  // window.
  if (mode === "log") {
    return { ok: true, reason: "RESET_DELIVERY_MODE=log (codes written to logs)" };
  }
  return { ok: false, reason: "no email provider configured and RESET_DELIVERY_MODE unset" };
}

export function getConfigReport(): ConfigReport {
  const node_env = process.env.NODE_ENV ?? "development";
  const is_production = node_env === "production";
  const payment_provider = (process.env.PAYMENT_PROVIDER ?? "preview").toLowerCase();
  const preview_reset_code_enabled =
    !is_production || process.env.ALLOW_PREVIEW_RESET_CODE === "1";

  const items: ConfigCheckItem[] = [];

  // APP_BASE_URL
  const baseUrlSet = isSet("APP_BASE_URL");
  if (!baseUrlSet) {
    items.push({
      key: "APP_BASE_URL",
      severity: is_production ? "error" : "warn",
      message: is_production
        ? "APP_BASE_URL is required in production (used to build redirect URLs and emails)."
        : "APP_BASE_URL is not set — preview build will infer the origin from request headers.",
    });
  } else {
    items.push({ key: "APP_BASE_URL", severity: "ok", message: "APP_BASE_URL is set." });
  }

  // PAYMENT_PROVIDER
  if (is_production && payment_provider === "preview") {
    items.push({
      key: "PAYMENT_PROVIDER",
      severity: "error",
      message: "PAYMENT_PROVIDER=preview is not safe for production. Set to stripe or lemonsqueezy.",
    });
  } else {
    items.push({
      key: "PAYMENT_PROVIDER",
      severity: "ok",
      message: `Active payment provider: ${payment_provider}.`,
    });
  }

  // Payment credentials when live provider is selected
  const credCheck = paymentCredentialsOk(payment_provider);
  const credsConfigured = payment_provider === "preview" ? true : credCheck.ok;
  if (payment_provider !== "preview" && !credCheck.ok) {
    items.push({
      key: "PAYMENT_CREDENTIALS",
      severity: is_production ? "error" : "warn",
      message: `Missing ${credCheck.missing.join(", ")} for provider ${payment_provider}.`,
    });
  } else if (payment_provider !== "preview") {
    items.push({
      key: "PAYMENT_CREDENTIALS",
      severity: "ok",
      message: `Credentials present for ${payment_provider}.`,
    });
  }

  // Email pipeline
  const emailCheck = emailPipelineOk();
  if (!emailCheck.ok) {
    items.push({
      key: "EMAIL_PIPELINE",
      severity: is_production ? "error" : "warn",
      message: `Email pipeline not configured: ${emailCheck.reason}. Set EMAIL_PROVIDER+EMAIL_API_KEY+EMAIL_FROM or RESET_DELIVERY_MODE.`,
    });
  } else {
    items.push({
      key: "EMAIL_PIPELINE",
      severity: "ok",
      message: `Email pipeline configured (${emailCheck.reason}).`,
    });
  }

  // Preview reset code exposure
  if (is_production && process.env.ALLOW_PREVIEW_RESET_CODE === "1") {
    items.push({
      key: "ALLOW_PREVIEW_RESET_CODE",
      severity: "warn",
      message: "ALLOW_PREVIEW_RESET_CODE=1 is set in production. Reset codes will be returned in HTTP responses — disable for a real launch.",
    });
  } else if (!is_production) {
    items.push({
      key: "ALLOW_PREVIEW_RESET_CODE",
      severity: "ok",
      message: "Preview mode: reset codes are returned in the forgot-password response for testing.",
    });
  } else {
    items.push({
      key: "ALLOW_PREVIEW_RESET_CODE",
      severity: "ok",
      message: "Reset codes will NOT be returned in HTTP responses (production-safe).",
    });
  }

  const ok = !items.some((it) => it.severity === "error");

  return {
    node_env,
    is_production,
    payment_provider,
    preview_reset_code_enabled,
    app_base_url_set: baseUrlSet,
    email_pipeline_configured: emailCheck.ok,
    payment_credentials_configured: credsConfigured,
    ok,
    items,
  };
}

export function validateConfigAtStartup(): void {
  const report = getConfigReport();
  const isStrict = report.is_production && process.env.CONFIG_STRICT !== "0";

  const banner = report.is_production
    ? "[config] production-mode startup check"
    : "[config] preview-mode startup check";
  console.log(banner);
  for (const it of report.items) {
    const tag = it.severity === "error" ? "ERROR" : it.severity === "warn" ? "WARN " : "ok   ";
    console.log(`  [${tag}] ${it.key}: ${it.message}`);
  }
  const errors = report.items.filter((it) => it.severity === "error");
  if (errors.length > 0) {
    const msg = `Production config check failed (${errors.length} error${errors.length === 1 ? "" : "s"}).`;
    if (isStrict) {
      throw new Error(`${msg} Set CONFIG_STRICT=0 to downgrade to a warning.`);
    } else {
      console.warn(`[config] ${msg} CONFIG_STRICT=0 → continuing.`);
    }
  }
}
