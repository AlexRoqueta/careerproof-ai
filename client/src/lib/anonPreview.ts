/* Helpers for the anonymous preview funnel.
 *
 * After a cold visitor generates a preview we stash the opaque token in
 * localStorage so it survives a page refresh / SignIn navigation. The
 * SignIn screen looks for it after a successful sign-up or sign-in and
 * POSTs to /api/preview/:token/claim — promoting the preview into a
 * real analyses row owned by the new account.
 *
 * The token is single-use server-side: a successful claim invalidates
 * it. We also clear localStorage after a successful claim so subsequent
 * sign-ins don't try to re-claim a stale token.
 *
 * NOTE: only the token is persisted. The preview payload itself stays
 * server-side under the token. The browser does NOT cache the
 * generated report locally — that would leak across users on a shared
 * device.
 */
const KEY = "cp.anon_preview_token";

export interface AnonPreviewPayload {
  token: string;
  created_at: string;
  expires_at: string;
  job_title: string;
  automation_risk: string;
  risk_score: number;
  summary: string;
  vulnerable_tasks: string[];
  locked_sections: string[];
}

export function readAnonPreviewToken(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const v = window.localStorage.getItem(KEY);
    return v && v.length > 0 ? v : null;
  } catch {
    return null;
  }
}

export function writeAnonPreviewToken(token: string | null): void {
  if (typeof window === "undefined") return;
  try {
    if (token) window.localStorage.setItem(KEY, token);
    else window.localStorage.removeItem(KEY);
  } catch {
    /* private mode — non-fatal */
  }
}

export function clearAnonPreviewToken(): void {
  writeAnonPreviewToken(null);
}

/* After a successful claim we stash the resulting analysis id under a
 * session-scoped sentinel so the Analyze page knows to mount the
 * report view straight away — no rerun, no extra navigation step.
 * sessionStorage is used (not localStorage) so a different browser tab
 * cannot pick up the same claim. */
const CLAIM_ID_KEY = "cp.just_claimed_analysis_id";

export function setJustClaimedAnalysisId(id: number | null): void {
  if (typeof window === "undefined") return;
  try {
    if (id == null) window.sessionStorage.removeItem(CLAIM_ID_KEY);
    else window.sessionStorage.setItem(CLAIM_ID_KEY, String(id));
  } catch {
    /* non-fatal */
  }
}

export function takeJustClaimedAnalysisId(): number | null {
  if (typeof window === "undefined") return null;
  try {
    const v = window.sessionStorage.getItem(CLAIM_ID_KEY);
    if (!v) return null;
    window.sessionStorage.removeItem(CLAIM_ID_KEY);
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}
