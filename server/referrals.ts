/* =====================================================================
 * Referral codes
 *
 * Each signed-in user can claim exactly one referral code (idempotent —
 * /api/referrals/me returns the existing code on subsequent calls).
 * The code is short, URL-safe, lowercase. Visitors arrive at the app
 * with `?ref=<code>`; the client picks it up and tags it on funnel
 * events at signup / purchase time so the admin dashboard can attribute
 * conversions back to the referring user.
 *
 * We deliberately do NOT pay anything out automatically. Attribution
 * + reporting only — payouts are a manual operator decision.
 * ===================================================================== */
import type { Express, Request, Response } from "express";
import { randomBytes } from "node:crypto";
import { storage } from "./storage";

const CODE_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789"; // crockford-ish, no look-alikes
const CODE_LEN = 8;

function generateReferralCode(): string {
  const bytes = randomBytes(CODE_LEN);
  let out = "";
  for (let i = 0; i < CODE_LEN; i++) {
    out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  }
  return out;
}

export function registerReferralRoutes(
  app: Express,
  getUserId: (req: Request) => number | null,
) {
  /* Return (or mint) the referral code for the current user. */
  app.get("/api/referrals/me", async (req: Request, res: Response) => {
    const id = getUserId(req);
    if (id == null) return res.status(401).json({ error: "Not signed in" });
    let row = await storage.getReferralCodeForUser(id);
    if (!row) {
      // Mint a new code with up to 5 retries on collision.
      let attempts = 0;
      while (!row && attempts < 5) {
        const candidate = generateReferralCode();
        const taken = await storage.getReferralCodeByCode(candidate);
        if (!taken) {
          try {
            row = await storage.createReferralCode({
              user_id: id,
              code: candidate,
              created_at: new Date().toISOString(),
            });
          } catch (err) {
            // Race — another request created one in parallel. Re-read.
            row = await storage.getReferralCodeForUser(id);
          }
        }
        attempts += 1;
      }
      if (!row) return res.status(500).json({ error: "Failed to mint referral code" });
    }
    res.json({ code: row.code, created_at: row.created_at });
  });

  /* Validate a referral code (used by the client to confirm a `?ref=`
   * query before storing it). Returns ok=true / false; never reveals
   * who owns the code. */
  app.get("/api/referrals/:code", async (req: Request, res: Response) => {
    const code = String(req.params.code || "").trim().toLowerCase();
    if (!code || code.length > 64) return res.json({ ok: false });
    const row = await storage.getReferralCodeByCode(code);
    res.json({ ok: !!row });
  });
}
