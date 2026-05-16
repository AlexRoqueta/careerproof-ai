/* =====================================================================
 * Outbound email delivery
 *
 * Today we only need transactional sends for the password-reset flow.
 * Two delivery paths are supported and selected entirely from env:
 *
 *   1. Resend (SaaS, HTTPS API) — preferred for production.
 *      Required env:
 *        EMAIL_PROVIDER=resend
 *        EMAIL_API_KEY=<resend key>
 *        EMAIL_FROM=<verified sender, e.g. "CareerProof <noreply@careerproof.app>">
 *
 *   2. Log mode — codes are written to the application log and NOT
 *      sent anywhere. Useful for local dev or a guided launch window.
 *      Required env:
 *        RESET_DELIVERY_MODE=log
 *
 * The module exposes one entry point, `sendPasswordResetEmail()`, that
 * never throws into the caller. On send failure it logs a non-secret
 * diagnostic and returns `{ delivered: false, ... }` so the route can
 * keep its generic 200 response and avoid leaking which emails exist.
 *
 * Security:
 *   - The Resend API key is read once per call from process.env and is
 *     NEVER logged. Only its presence is reported.
 *   - The reset code itself is never logged outside of explicit log
 *     mode (where the operator opted in).
 * ===================================================================== */

export type EmailProvider = "resend" | "log" | "none";

export interface PasswordResetEmailInput {
  to: string;
  code: string;
  appBaseUrl?: string;
  ttlMinutes: number;
}

export interface SendResult {
  delivered: boolean;
  provider: EmailProvider;
  reason?: string;
  message_id?: string;
}

function envValue(name: string): string {
  const v = process.env[name];
  return typeof v === "string" ? v.trim() : "";
}

export function selectEmailProvider(): EmailProvider {
  const provider = envValue("EMAIL_PROVIDER").toLowerCase();
  if (provider === "resend" && envValue("EMAIL_API_KEY") && envValue("EMAIL_FROM")) {
    return "resend";
  }
  const mode = envValue("RESET_DELIVERY_MODE").toLowerCase();
  if (mode === "log") return "log";
  return "none";
}

function buildResetEmailBody(input: PasswordResetEmailInput): { subject: string; text: string; html: string } {
  const { code, appBaseUrl, ttlMinutes } = input;
  const signInUrl = appBaseUrl ? `${appBaseUrl.replace(/\/+$/, "")}/signin` : null;
  const subject = "Your CareerProof password reset code";
  const linkLine = signInUrl ? `\nReturn to sign in: ${signInUrl}\n` : "";
  const text = [
    "Hi,",
    "",
    "We received a request to reset the password on your CareerProof account.",
    "",
    `Your reset code is: ${code}`,
    "",
    `This code expires in ${ttlMinutes} minutes and can only be used once.`,
    linkLine,
    "If you did not request this, you can safely ignore this email — your password will stay the same.",
    "",
    "— The CareerProof team",
  ].join("\n");

  const escapedCode = code.replace(/[<>&]/g, (c) =>
    c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&amp;",
  );
  const linkHtml = signInUrl
    ? `<p style="margin:16px 0;font-size:14px;color:#475569"><a href="${signInUrl}" style="color:#2563eb;text-decoration:none">Return to sign in</a></p>`
    : "";
  const html = `<!doctype html>
<html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f8fafc;padding:24px;color:#0f172a">
  <div style="max-width:480px;margin:0 auto;background:#ffffff;border:1px solid #e2e8f0;border-radius:12px;padding:28px">
    <h1 style="font-size:18px;margin:0 0 12px">Reset your CareerProof password</h1>
    <p style="margin:0 0 16px;font-size:14px;color:#334155">We received a request to reset the password on your CareerProof account. Use the code below to continue.</p>
    <div style="font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:28px;letter-spacing:6px;font-weight:600;background:#f1f5f9;border:1px solid #e2e8f0;border-radius:8px;padding:14px 16px;text-align:center;margin:8px 0 16px">${escapedCode}</div>
    <p style="margin:0 0 16px;font-size:13px;color:#64748b">This code expires in ${ttlMinutes} minutes and can only be used once.</p>
    ${linkHtml}
    <p style="margin:24px 0 0;font-size:12px;color:#94a3b8">If you did not request this, you can safely ignore this email — your password will stay the same.</p>
  </div>
</body></html>`;
  return { subject, text, html };
}

async function sendViaResend(input: PasswordResetEmailInput): Promise<SendResult> {
  const apiKey = envValue("EMAIL_API_KEY");
  const from = envValue("EMAIL_FROM");
  if (!apiKey || !from) {
    return {
      delivered: false,
      provider: "resend",
      reason: "EMAIL_API_KEY or EMAIL_FROM missing",
    };
  }
  const { subject, text, html } = buildResetEmailBody(input);
  let response: Response;
  try {
    response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from,
        to: [input.to],
        subject,
        text,
        html,
      }),
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.error(`[email] resend network error to=${redactEmail(input.to)} reason=${reason}`);
    return { delivered: false, provider: "resend", reason };
  }
  const rawBody = await response.text().catch(() => "");
  let body: any = null;
  try {
    body = rawBody ? JSON.parse(rawBody) : null;
  } catch {
    body = rawBody;
  }
  if (!response.ok) {
    const reason =
      (body && typeof body === "object" && (body.message || body.error)) ||
      `HTTP ${response.status}`;
    console.error(
      `[email] resend send failed to=${redactEmail(input.to)} status=${response.status} reason=${String(reason).slice(0, 200)}`,
    );
    return { delivered: false, provider: "resend", reason: String(reason) };
  }
  const messageId =
    body && typeof body === "object" && typeof body.id === "string" ? body.id : undefined;
  console.log(
    `[email] resend send ok to=${redactEmail(input.to)} message_id=${messageId ?? "(unknown)"}`,
  );
  return { delivered: true, provider: "resend", message_id: messageId };
}

function redactEmail(addr: string): string {
  const at = addr.indexOf("@");
  if (at <= 1) return "***";
  const local = addr.slice(0, at);
  const domain = addr.slice(at + 1);
  const visible = local.slice(0, 2);
  return `${visible}***@${domain}`;
}

export async function sendPasswordResetEmail(
  input: PasswordResetEmailInput,
): Promise<SendResult> {
  const provider = selectEmailProvider();
  if (provider === "resend") {
    return sendViaResend(input);
  }
  if (provider === "log") {
    console.log(
      `[email] RESET_DELIVERY_MODE=log: password reset code for ${input.to} is ${input.code} (expires in ${input.ttlMinutes} minutes)`,
    );
    return { delivered: true, provider: "log" };
  }
  return {
    delivered: false,
    provider: "none",
    reason: "no email provider configured (EMAIL_PROVIDER/EMAIL_API_KEY/EMAIL_FROM or RESET_DELIVERY_MODE=log)",
  };
}
