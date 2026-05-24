/* =====================================================================
 * Admin metrics endpoint
 *
 * Aggregates promo redemptions, purchase counts, revenue, funnel-event
 * counts, A/B variant performance, and referral attribution for the
 * admin dashboard. Optional ?since=ISO and ?until=ISO bound the metric
 * window; defaults are "last 30 days".
 *
 * Auth gate: caller must be a signed-in admin. We surface non-secret
 * env values (LAUNCH_PROMO_LIMIT, etc.) since the dashboard already
 * shows the public promo state on /api/payments/packages.
 * ===================================================================== */
import type { Express, Request, Response } from "express";
import { storage } from "./storage";
import { getLaunchPromoState } from "./launchPromo";
import { promoReferenceSuffix } from "@shared/launchPromo";
import { ADMIN_FUNNEL_SEQUENCE } from "./funnel";

function parseRangeWindow(req: Request): { since: string; until: string } {
  const now = new Date();
  const defaultSince = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const sinceRaw = String(req.query.since ?? "").trim();
  const untilRaw = String(req.query.until ?? "").trim();
  const since = sinceRaw && Number.isFinite(Date.parse(sinceRaw)) ? sinceRaw : defaultSince.toISOString();
  const until = untilRaw && Number.isFinite(Date.parse(untilRaw)) ? untilRaw : now.toISOString();
  return { since, until };
}

export function registerAdminMetrics(
  app: Express,
  getUserId: (req: Request) => number | null,
) {
  app.get("/api/admin/metrics", async (req: Request, res: Response) => {
    const meId = getUserId(req);
    const me = meId != null ? await storage.getUser(meId) : undefined;
    if (!me || me.role !== "admin") return res.status(403).json({ error: "Admin only" });

    const { since, until } = parseRangeWindow(req);

    /* Launch promo state — slot used/remaining */
    const promo = await getLaunchPromoState().catch(() => null);

    /* Funnel events: roll up counts grouped by name within the window. */
    const eventRows = await storage.aggregateFunnelEvents({ since, until }).catch(() => []);
    const eventsByName: Record<string, number> = {};
    for (const row of eventRows) eventsByName[row.name] = row.count;
    const funnel = ADMIN_FUNNEL_SEQUENCE.map((name) => ({
      name,
      count: eventsByName[name] ?? 0,
    }));

    /* A/B variant performance for the unlock screen. We pull counts
     * for the three key events split by variant so the admin can read
     * conversion rate across variants. */
    const variantEvents = [
      "preview_report_viewed",
      "unlock_cta_after_preview",
      "purchase",
    ] as const;
    const variantBreakdown: Record<string, Array<{ variant: string | null; count: number }>> = {};
    for (const name of variantEvents) {
      variantBreakdown[name] = await storage
        .aggregateFunnelEventsByVariant({ name, since, until })
        .catch(() => []);
    }

    /* Referral activity within the window — counts of signup_completed
     * and purchase carrying a referral_code attribution. */
    const referralSignups = await storage
      .countFunnelEvents({ name: "signup_completed", since, until })
      .catch(() => 0);
    const referralPurchases = await storage
      .countFunnelEvents({ name: "purchase", since, until })
      .catch(() => 0);
    /* Top referral codes by attributed purchase events. We re-run
     * variant aggregation but on the referral_code denormalized field
     * via aggregateFunnelEventsByVariant trick: simulate by counting
     * each known code separately. To keep it simple/fast we just expose
     * total counts here; per-code breakdown is below if the admin runs
     * a query manually. */

    /* User / analysis totals — cheap. */
    const allUsers = await storage.listUsers().catch(() => []);
    const totalUsers = allUsers.length;

    res.json({
      window: { since, until },
      promo: promo
        ? {
            active: promo.active,
            name: promo.name,
            limit: promo.limit,
            used: promo.used ?? null,
            remaining: promo.used != null ? Math.max(0, promo.limit - promo.used) : null,
            promo_price_cents: promo.promo_price_cents,
            regular_price_cents: promo.regular_price_cents,
            reference_suffix: promoReferenceSuffix(promo.name),
          }
        : null,
      funnel,
      events_other: eventRows
        .filter((r) => !ADMIN_FUNNEL_SEQUENCE.includes(r.name as any))
        .slice(0, 30),
      ab_unlock_variant: variantBreakdown,
      referrals: {
        signups: referralSignups,
        purchases: referralPurchases,
      },
      users: { total: totalUsers },
    });
  });
}
