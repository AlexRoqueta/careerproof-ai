/* Pending-unlock target persistence.
 *
 * When a user clicks "Buy credits to unlock" from a locked report,
 * we remember the target analysis id so that the Credits page can
 * auto-unlock that exact report after a successful purchase. The
 * value survives the hosted-checkout redirect (Stripe) because it
 * lives in localStorage on the same origin, and is independent of
 * the in-memory React state which is lost on full-page navigation.
 *
 * The value is intentionally cleared as soon as the unlock attempt
 * succeeds (or definitively fails) so a stale id from a previous
 * session never auto-unlocks an unrelated future purchase.
 */
const KEY = "cp.pending_unlock_analysis_id";

export function setPendingUnlockAnalysisId(id: number): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(KEY, String(id));
  } catch {
    /* localStorage may be unavailable (private mode) — non-fatal */
  }
}

export function getPendingUnlockAnalysisId(): number | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return null;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

export function clearPendingUnlockAnalysisId(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(KEY);
  } catch {
    /* non-fatal */
  }
}
