/* =====================================================================
 * Preview follow-up emails
 *
 * After a signed-in user views their AI Exposure preview we queue a
 * follow-up email via Resend. Two kinds of sends are supported:
 *
 *   - immediate: sent on the same request, captured in
 *     preview_follow_ups with status=sent.
 *   - delayed_24h: a pending row written now with scheduled_for=+24h.
 *     A lightweight processor (kickPreviewFollowupProcessor) iterates
 *     pending rows whose scheduled_for has elapsed and sends them, then
 *     marks them done.
 *
 * Idempotency is enforced by the unique (user_id, kind) constraint on
 * preview_follow_ups — so even if the route fires twice the second send
 * is a no-op.
 *
 * Anonymous users never get an email — no address is available and we
 * refuse to ever guess one. The client surfaces a sign-up prompt for
 * anonymous viewers instead.
 *
 * Unsubscribe-safe: the body includes a clear single-sentence "reply
 * to stop these messages" note and links back to the user's account
 * page. We do not send promotional content; the messages are useful
 * summary + a next-step CTA.
 * ===================================================================== */
import { storage } from "./storage";
import { selectEmailProvider } from "./email";
import { logServerEvent } from "./funnel";

const DELAYED_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24h

interface SendInput {
  to: string;
  subject: string;
  text: string;
  html: string;
  reply_to?: string;
}

async function sendViaResend(input: SendInput): Promise<{ ok: boolean; reason?: string }> {
  const apiKey = (process.env.EMAIL_API_KEY ?? "").trim();
  const from = (process.env.EMAIL_FROM ?? "").trim();
  if (!apiKey || !from) return { ok: false, reason: "missing_credentials" };
  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from,
        to: [input.to],
        subject: input.subject,
        text: input.text,
        html: input.html,
        ...(input.reply_to ? { reply_to: input.reply_to } : {}),
      }),
    });
    if (!r.ok) {
      const bodyText = await r.text().catch(() => "");
      return { ok: false, reason: `http_${r.status}: ${bodyText.slice(0, 200)}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

function buildImmediateEmail(args: {
  full_name: string;
  job_title: string;
  risk_score: number;
  automation_risk: string;
  app_base_url: string;
  is_locked: boolean;
}): { subject: string; text: string; html: string } {
  const subject = `Your AI Exposure Report for ${args.job_title} is ready`;
  const ctaUrl = `${args.app_base_url.replace(/\/+$/, "")}/#/analyze`;
  const lockedNote = args.is_locked
    ? `Your free preview is unlocked. The full report — with task-by-task breakdown, AI tools to learn, and a 30/60/90-day plan — unlocks for one credit (currently $1 during the launch promo).`
    : `Your full AI Exposure Report is unlocked. You can re-open or print it from your account at any time.`;
  const text = [
    `Hi ${args.full_name.split(/\s+/)[0] || "there"},`,
    "",
    `Your AI Exposure Report for ${args.job_title} is ready.`,
    `Overall AI exposure: ${args.automation_risk} (score ${args.risk_score}/100).`,
    "",
    `${lockedNote}`,
    "",
    `Open your report: ${ctaUrl}`,
    "",
    "What to do in the next 7 days:",
    "1. Look at the most exposed tasks in your role and pick one to delegate to an AI tool.",
    "2. Pick one skill from the report and start a small project this month.",
    "3. Calendar the 30/60/90-day plan even loosely so the next move is easy.",
    "",
    "Career-risk intelligence is directional — not a guarantee. Use it to plan, not to panic.",
    "",
    "— CareerProof AI",
    "",
    "You're receiving this because you ran a preview on CareerProof AI. Reply to stop these messages.",
  ].join("\n");
  const html = `<!doctype html><html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f8fafc;padding:24px;color:#0f172a">
    <div style="max-width:560px;margin:0 auto;background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:28px">
      <h1 style="font-size:20px;margin:0 0 12px">Your AI Exposure Report is ready</h1>
      <p style="margin:0 0 12px;color:#334155">Hi ${escapeHtml(args.full_name.split(/\s+/)[0] || "there")} — your report for <strong>${escapeHtml(args.job_title)}</strong> is ready.</p>
      <p style="margin:0 0 8px;color:#334155">Overall AI exposure: <strong>${escapeHtml(args.automation_risk)}</strong> (score ${args.risk_score}/100).</p>
      <p style="margin:14px 0;color:#475569">${escapeHtml(lockedNote)}</p>
      <p style="margin:18px 0"><a href="${ctaUrl}" style="display:inline-block;padding:11px 18px;background:#2563eb;color:#fff;border-radius:8px;text-decoration:none;font-weight:600">Open my report</a></p>
      <h2 style="font-size:14px;margin:18px 0 8px;color:#0f172a">In the next 7 days</h2>
      <ol style="padding-left:20px;color:#334155;margin:0 0 14px">
        <li>Pick the most exposed task from your report and delegate it to an AI tool.</li>
        <li>Pick one skill and start a small project this month.</li>
        <li>Calendar the 30/60/90-day plan so the next move is easy.</li>
      </ol>
      <p style="margin:24px 0 0;font-size:12px;color:#94a3b8">Career-risk intelligence is directional — not a guarantee. Use it to plan, not to panic.</p>
      <p style="margin:8px 0 0;font-size:12px;color:#94a3b8">You're receiving this because you ran a preview on CareerProof AI. Reply to stop these messages.</p>
    </div>
  </body></html>`;
  return { subject, text, html };
}

function buildDelayedEmail(args: { full_name: string; job_title: string; app_base_url: string }) {
  const ctaUrl = `${args.app_base_url.replace(/\/+$/, "")}/#/analyze`;
  const subject = `Quick follow-up on your ${args.job_title} AI Exposure Report`;
  const text = [
    `Hi ${args.full_name.split(/\s+/)[0] || "there"},`,
    "",
    `Yesterday you ran an AI Exposure preview for ${args.job_title}. Two practical things you can do today:`,
    "",
    "1. Re-read the most exposed task in your report. Could you pass it off to an AI tool this week?",
    "2. Pick one skill the report flagged and block 30 minutes tomorrow to start.",
    "",
    `Open your report: ${ctaUrl}`,
    "",
    "If unlocking the full report is on your list, the launch promo ($1 instead of $3) is still available while spots remain.",
    "",
    "— CareerProof AI",
    "",
    "Reply to stop these messages.",
  ].join("\n");
  const html = `<!doctype html><html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f8fafc;padding:24px;color:#0f172a">
    <div style="max-width:560px;margin:0 auto;background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:28px">
      <h1 style="font-size:18px;margin:0 0 12px">Two things you can do today</h1>
      <p style="margin:0 0 12px;color:#334155">Yesterday you ran a preview for <strong>${escapeHtml(args.job_title)}</strong>. Two practical next steps:</p>
      <ol style="padding-left:20px;color:#334155;margin:0 0 14px">
        <li>Re-read the most exposed task and pass it off to an AI tool this week.</li>
        <li>Pick one skill the report flagged and block 30 minutes tomorrow to start.</li>
      </ol>
      <p style="margin:18px 0"><a href="${ctaUrl}" style="display:inline-block;padding:11px 18px;background:#2563eb;color:#fff;border-radius:8px;text-decoration:none;font-weight:600">Open my report</a></p>
      <p style="margin:14px 0;color:#475569;font-size:14px">If unlocking the full report is on your list, the launch promo ($1 instead of $3) is still available while spots remain.</p>
      <p style="margin:8px 0 0;font-size:12px;color:#94a3b8">Reply to stop these messages.</p>
    </div>
  </body></html>`;
  return { subject, text, html };
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&quot;",
  );
}

interface QueueFollowupInput {
  user_id: number;
  user_email: string;
  full_name: string;
  job_title: string;
  risk_score: number;
  automation_risk: string;
  is_locked: boolean;
  analysis_id?: number | null;
  app_base_url: string;
}

/* Queue (and send when applicable) the immediate + delayed follow-ups
 * for a fresh preview view. Idempotent — uses unique (user_id, kind)
 * to guard against double-sends. */
export async function queuePreviewFollowups(input: QueueFollowupInput): Promise<void> {
  const provider = selectEmailProvider();
  if (provider === "none") {
    // No outbound provider — skip queuing entirely so we don't pile up
    // permanently-pending rows on a deployment without email creds.
    return;
  }
  // Immediate send.
  const existingImmediate = await storage.getPreviewFollowUp(input.user_id, "immediate");
  if (!existingImmediate) {
    let row;
    try {
      row = await storage.createPreviewFollowUp({
        user_id: input.user_id,
        analysis_id: input.analysis_id ?? null,
        kind: "immediate",
        scheduled_for: null,
        sent_at: null,
        status: "pending",
        reason: null,
      });
    } catch {
      // Unique constraint raced — already queued.
      row = await storage.getPreviewFollowUp(input.user_id, "immediate");
    }
    if (row && row.status === "pending") {
      const email = buildImmediateEmail({
        full_name: input.full_name,
        job_title: input.job_title,
        risk_score: input.risk_score,
        automation_risk: input.automation_risk,
        app_base_url: input.app_base_url,
        is_locked: input.is_locked,
      });
      const result = await sendViaResend({
        to: input.user_email,
        subject: email.subject,
        text: email.text,
        html: email.html,
      });
      await storage.updatePreviewFollowUp(row.id, {
        status: result.ok ? "sent" : "failed",
        sent_at: result.ok ? new Date().toISOString() : null,
        reason: result.ok ? null : result.reason ?? null,
      });
      await logServerEvent({
        name: result.ok ? "preview_followup_immediate_sent" : "preview_followup_immediate_failed",
        user_id: input.user_id,
      });
    }
  }
  // Delayed send — schedule but do NOT send now.
  const existingDelayed = await storage.getPreviewFollowUp(input.user_id, "delayed_24h");
  if (!existingDelayed) {
    try {
      await storage.createPreviewFollowUp({
        user_id: input.user_id,
        analysis_id: input.analysis_id ?? null,
        kind: "delayed_24h",
        scheduled_for: new Date(Date.now() + DELAYED_INTERVAL_MS).toISOString(),
        sent_at: null,
        status: "pending",
        reason: null,
      });
    } catch {
      // Already queued — fine.
    }
  }
}

let processorTimer: NodeJS.Timeout | null = null;

/* Process due delayed follow-ups. Called on a slow interval from
 * server startup. Bounded to ~50 rows per pass to avoid surprising
 * email-provider rate spikes. */
async function runDelayedProcessorPass(): Promise<void> {
  const provider = selectEmailProvider();
  if (provider === "none") return;
  const due = await storage.listPendingPreviewFollowUps(new Date().toISOString()).catch(() => []);
  if (!due.length) return;
  for (const row of due) {
    if (row.kind !== "delayed_24h") continue;
    const user = await storage.getUser(row.user_id).catch(() => null);
    if (!user) {
      await storage.updatePreviewFollowUp(row.id, { status: "skipped", reason: "user_missing" });
      continue;
    }
    const baseUrl = (process.env.APP_BASE_URL ?? "").trim() || "https://careerproof.app";
    // Look up any analysis we logged with the row to fill the subject.
    let jobTitle = "your role";
    if (row.analysis_id != null) {
      const a = await storage.getAnalysis(row.analysis_id).catch(() => undefined);
      if (a) jobTitle = a.job_title;
    }
    const email = buildDelayedEmail({
      full_name: user.full_name,
      job_title: jobTitle,
      app_base_url: baseUrl,
    });
    const result = await sendViaResend({
      to: user.email,
      subject: email.subject,
      text: email.text,
      html: email.html,
    });
    await storage.updatePreviewFollowUp(row.id, {
      status: result.ok ? "sent" : "failed",
      sent_at: result.ok ? new Date().toISOString() : null,
      reason: result.ok ? null : result.reason ?? null,
    });
    await logServerEvent({
      name: result.ok ? "preview_followup_delayed_sent" : "preview_followup_delayed_failed",
      user_id: user.id,
    });
  }
}

export function kickPreviewFollowupProcessor(): void {
  if (processorTimer) return;
  // Initial delay of 30s to let the app finish booting, then every 10
  // minutes. The interval is intentionally generous — preview follow-ups
  // aren't time-critical, and a slow cadence keeps the email-provider
  // load steady.
  processorTimer = setTimeout(function tick() {
    void runDelayedProcessorPass().catch(() => {});
    processorTimer = setTimeout(tick, 10 * 60_000);
  }, 30_000);
  // Don't keep the process alive just for this.
  if (typeof (processorTimer as any).unref === "function") {
    (processorTimer as any).unref();
  }
}
