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

/* =====================================================================
 * Analysis feedback email
 *
 * Sends a short, structured email summarizing one user's rating of
 * their AI Exposure preview/report. The recipient is configured
 * server-side (env ANALYSIS_FEEDBACK_TO, default roqueta.alex@gmail.com)
 * so the client cannot redirect feedback to an arbitrary address.
 *
 * The body intentionally does NOT include the full report text — only
 * the rating, optional free-text comment, and a few identifying
 * fields. Sensitive content stays in our DB.
 * ===================================================================== */
export interface AnalysisFeedbackEmailInput {
  to: string;
  rating: number; // 1-5
  comment?: string;
  /** Free-first survey answer: "what would make this worth paying for?" */
  worth_paying_for?: string;
  user_id?: number | null;
  user_email?: string | null;
  job_title?: string | null;
  analysis_id?: number | null;
  was_locked: boolean;
  source_url?: string | null;
  user_agent?: string | null;
  timestamp: string; // ISO
}

function buildFeedbackEmailBody(input: AnalysisFeedbackEmailInput): {
  subject: string;
  text: string;
  html: string;
} {
  const clamped = Math.max(0, Math.min(5, Math.round(input.rating)));
  const stars = "★".repeat(clamped) + "☆".repeat(5 - clamped);
  const stateLabel = input.was_locked ? "Free preview" : "Full report";
  const subject = `CareerProof feedback: ${clamped}/5 stars - ${stateLabel}`;

  const lines = [
    `Rating: ${clamped}/5 (${stars})`,
    `Report state: ${stateLabel}`,
    input.job_title ? `Job title: ${input.job_title}` : null,
    input.user_email ? `User email: ${input.user_email}` : "User email: (anonymous)",
    input.user_id != null ? `User id: ${input.user_id}` : null,
    input.analysis_id != null ? `Analysis id: ${input.analysis_id}` : null,
    input.source_url ? `Source page: ${input.source_url}` : null,
    input.user_agent ? `User agent: ${input.user_agent}` : null,
    `Submitted: ${input.timestamp}`,
    "",
    "Comment:",
    input.comment && input.comment.trim().length > 0 ? input.comment.trim() : "(no comment)",
    "",
    "What would make this worth paying for:",
    input.worth_paying_for && input.worth_paying_for.trim().length > 0
      ? input.worth_paying_for.trim()
      : "(no answer)",
  ].filter(Boolean) as string[];
  const text = lines.join("\n");

  const escape = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const commentHtml =
    input.comment && input.comment.trim().length > 0
      ? `<pre style="margin:0;white-space:pre-wrap;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:13px;color:#0f172a">${escape(
          input.comment.trim(),
        )}</pre>`
      : `<p style="margin:0;color:#94a3b8;font-style:italic">(no comment)</p>`;
  const worthPayingHtml =
    input.worth_paying_for && input.worth_paying_for.trim().length > 0
      ? `<pre style="margin:0;white-space:pre-wrap;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:13px;color:#0f172a">${escape(
          input.worth_paying_for.trim(),
        )}</pre>`
      : `<p style="margin:0;color:#94a3b8;font-style:italic">(no answer)</p>`;

  const rows: { label: string; value: string }[] = [
    { label: "Rating", value: `${clamped}/5 (${stars})` },
    { label: "Report state", value: stateLabel },
  ];
  if (input.job_title) rows.push({ label: "Job title", value: input.job_title });
  rows.push({ label: "User email", value: input.user_email ?? "(anonymous)" });
  if (input.user_id != null) rows.push({ label: "User id", value: String(input.user_id) });
  if (input.analysis_id != null)
    rows.push({ label: "Analysis id", value: String(input.analysis_id) });
  if (input.source_url) rows.push({ label: "Source page", value: input.source_url });
  if (input.user_agent) rows.push({ label: "User agent", value: input.user_agent });
  rows.push({ label: "Submitted", value: input.timestamp });

  const rowsHtml = rows
    .map(
      (r) =>
        `<tr><td style="padding:4px 12px 4px 0;color:#64748b;font-size:12px;text-transform:uppercase;letter-spacing:0.06em;white-space:nowrap;vertical-align:top">${escape(
          r.label,
        )}</td><td style="padding:4px 0;font-size:14px;color:#0f172a;vertical-align:top">${escape(
          r.value,
        )}</td></tr>`,
    )
    .join("");

  const html = `<!doctype html>
<html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f8fafc;padding:24px;color:#0f172a">
  <div style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #e2e8f0;border-radius:12px;padding:28px">
    <div style="font-size:11px;text-transform:uppercase;letter-spacing:0.14em;color:#0891b2;font-weight:600">CareerProof AI - Feedback</div>
    <h1 style="font-size:20px;margin:8px 0 16px">${clamped}/5 - ${escape(stateLabel)}</h1>
    <table cellpadding="0" cellspacing="0" style="border-collapse:collapse;width:100%;margin-bottom:16px">${rowsHtml}</table>
    <div style="border-top:1px solid #e2e8f0;padding-top:12px">
      <div style="font-size:11px;text-transform:uppercase;letter-spacing:0.08em;color:#64748b;font-weight:600;margin-bottom:6px">Comment</div>
      ${commentHtml}
    </div>
    <div style="border-top:1px solid #e2e8f0;padding-top:12px;margin-top:12px">
      <div style="font-size:11px;text-transform:uppercase;letter-spacing:0.08em;color:#64748b;font-weight:600;margin-bottom:6px">What would make this worth paying for</div>
      ${worthPayingHtml}
    </div>
  </div>
</body></html>`;

  return { subject, text, html };
}

async function sendFeedbackViaResend(
  input: AnalysisFeedbackEmailInput,
): Promise<SendResult> {
  const apiKey = envValue("EMAIL_API_KEY");
  const from = envValue("EMAIL_FROM");
  if (!apiKey || !from) {
    return {
      delivered: false,
      provider: "resend",
      reason: "EMAIL_API_KEY or EMAIL_FROM missing",
    };
  }
  const { subject, text, html } = buildFeedbackEmailBody(input);
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
        ...(input.user_email ? { reply_to: input.user_email } : {}),
      }),
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.error(
      `[email] feedback resend network error to=${redactEmail(input.to)} reason=${reason}`,
    );
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
      `[email] feedback resend send failed to=${redactEmail(input.to)} status=${response.status} reason=${String(reason).slice(0, 200)}`,
    );
    return { delivered: false, provider: "resend", reason: String(reason) };
  }
  const messageId =
    body && typeof body === "object" && typeof body.id === "string" ? body.id : undefined;
  console.log(
    `[email] feedback resend send ok to=${redactEmail(input.to)} message_id=${messageId ?? "(unknown)"}`,
  );
  return { delivered: true, provider: "resend", message_id: messageId };
}

export async function sendAnalysisFeedbackEmail(
  input: AnalysisFeedbackEmailInput,
): Promise<SendResult> {
  const provider = selectEmailProvider();
  if (provider === "resend") {
    return sendFeedbackViaResend(input);
  }
  if (provider === "log") {
    const { subject, text } = buildFeedbackEmailBody(input);
    console.log(
      `[email] RESET_DELIVERY_MODE=log: analysis feedback for ${redactEmail(input.to)} - ${subject}\n${text}`,
    );
    return { delivered: true, provider: "log" };
  }
  // Always log the feedback to the server console even when no email
  // provider is configured - losing user feedback silently is worse
  // than getting it via logs.
  const { subject, text } = buildFeedbackEmailBody(input);
  console.log(
    `[email] no provider configured - feedback would have gone to ${redactEmail(input.to)} - ${subject}\n${text}`,
  );
  return {
    delivered: false,
    provider: "none",
    reason: "no email provider configured (EMAIL_PROVIDER/EMAIL_API_KEY/EMAIL_FROM or RESET_DELIVERY_MODE=log)",
  };
}
