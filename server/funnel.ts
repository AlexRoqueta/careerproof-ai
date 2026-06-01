/* =====================================================================
 * First-party funnel event logging + admin aggregates
 *
 * Lightweight, idempotent event log used by the admin dashboard. The
 * client POSTs to /api/events with {name, props, anon_id, variant,
 * referral_code} after key funnel moments (preview viewed, unlock CTA
 * clicked, referral signup, etc.). The server fills in the timestamp
 * and the signed-in user id when one is available.
 *
 * Storage is intentionally narrow — a single events table with name +
 * created_at indices. Aggregates use SQL COUNT/GROUP BY so the admin
 * page stays responsive even when the table grows.
 * ===================================================================== */
import type { Request, Response, Express } from "express";
import { storage } from "./storage";
import { funnelEventRequestSchema } from "@shared/schema";
import { rateLimit, keyByIp } from "./rate-limit";

const PROPS_MAX_BYTES = 4096;

/* Stable canonical event names that the admin dashboard knows how to
 * roll up into a funnel. Other names still log (so we don't drop new
 * events the client adds), but the dashboard only renders the canonical
 * sequence in funnel order. */
export const ADMIN_FUNNEL_SEQUENCE = [
  "landing_view",
  "landing_cta_click",
  "anonymous_preview_started",
  "preview_report_viewed",
  "signup_started",
  "signup_completed",
  "free_full_report_claimed",
  "full_report_viewed",
  "free_report_feedback_submitted",
  "referral_link_copied",
  "second_report_started",
  "buy_credits_clicked",
  "checkout_started",
  "purchase",
] as const;

export function registerFunnelEventRoute(app: Express, getUserId: (req: Request) => number | null) {
  const limit = rateLimit({ scope: "events", max: 60, windowMs: 60_000, keyFn: keyByIp });
  app.post("/api/events", limit, async (req: Request, res: Response) => {
    const parsed = funnelEventRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      // We deliberately swallow validation failures with a 204 — losing a
      // single event is fine, and we don't want a noisy log if a future
      // client version sends a stale shape.
      return res.status(204).end();
    }
    const { name, anon_id, variant, referral_code, props } = parsed.data;
    let propsText: string | null = null;
    if (props && typeof props === "object") {
      try {
        const serialized = JSON.stringify(props);
        propsText = serialized.length > PROPS_MAX_BYTES
          ? serialized.slice(0, PROPS_MAX_BYTES)
          : serialized;
      } catch {
        propsText = null;
      }
    }
    try {
      await storage.appendFunnelEvent({
        name,
        created_at: new Date().toISOString(),
        anon_id: anon_id || null,
        user_id: getUserId(req),
        props: propsText,
        variant: variant || null,
        referral_code: referral_code || null,
      });
    } catch (err) {
      // Log but never fail the request — analytics losses must not
      // surface to end users.
      console.warn("[events] append failed:", err);
    }
    res.status(204).end();
  });
}

/* Direct-from-server event helper. Used when the server itself wants to
 * log a funnel event (e.g. preview email queued, follow-up email sent)
 * without bouncing through the client. */
export async function logServerEvent(input: {
  name: string;
  user_id?: number | null;
  variant?: string | null;
  referral_code?: string | null;
  props?: Record<string, unknown>;
}): Promise<void> {
  let propsText: string | null = null;
  if (input.props) {
    try {
      const serialized = JSON.stringify(input.props);
      propsText = serialized.length > PROPS_MAX_BYTES
        ? serialized.slice(0, PROPS_MAX_BYTES)
        : serialized;
    } catch {
      propsText = null;
    }
  }
  try {
    await storage.appendFunnelEvent({
      name: input.name,
      created_at: new Date().toISOString(),
      anon_id: null,
      user_id: input.user_id ?? null,
      props: propsText,
      variant: input.variant ?? null,
      referral_code: input.referral_code ?? null,
    });
  } catch (err) {
    console.warn(`[events] server-side append failed for ${input.name}:`, err);
  }
}
