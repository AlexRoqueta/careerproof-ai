/* =====================================================================
 * Anonymous preview store
 *
 * Cold visitors (e.g. ad traffic from Meta/Reels) should be able to
 * generate an AI job-risk preview WITHOUT first creating an account.
 * We persist these previews in-memory only, keyed by a cryptographically
 * random opaque token. The token is the sole way to retrieve a preview,
 * so:
 *
 *   - Tokens are 32-byte base64url — guessing one is computationally
 *     infeasible. Integer ids are NEVER exposed.
 *   - Previews are NOT written to the SQL store and are not associated
 *     with any user until they are explicitly claimed via
 *     POST /api/preview/:token/claim. This avoids polluting the DB with
 *     ad-driven cold traffic and keeps the per-user history clean.
 *   - Each entry has a TTL (default 24h) and is evicted lazily on
 *     access plus by a periodic sweep. The store has a hard cap to
 *     bound memory.
 *   - Claiming a preview consumes the token (single-use) and creates a
 *     real `analyses` row owned by the claiming user. The owner's
 *     credit / unlimited entitlement decides whether the row lands
 *     locked or unlocked, just like a fresh authenticated analysis.
 *   - Anonymous abuse controls are enforced in routes (per-IP rate
 *     limits) in addition to the size cap here.
 *
 * This module is purely server-side. Tokens never round-trip through
 * cookies or sessions — the browser stashes its own token in
 * localStorage so the user can return later before signing up.
 * ===================================================================== */
import { randomBytes } from "node:crypto";
import type { Analysis } from "@shared/schema";

export interface AnonPreviewRecord {
  /** Opaque random token — the URL-safe id for retrieval. */
  token: string;
  /** ISO created timestamp. */
  created_at: string;
  /** Epoch ms when this preview expires and is evicted. */
  expires_at_ms: number;
  /** Inputs the user submitted (echoed back so claim can build a row). */
  job_title: string;
  job_description: string;
  technology_context: string | null;
  /** Output of the AI generation. */
  result_text: string;
  provider_used: string;
  automation_risk: string;
  risk_score: number;
  /** First-party fingerprint for abuse triage (NOT used for auth). */
  source_ip: string | null;
}

/** Anonymous preview payload returned to the browser. Never includes
 * the full readable body — only the score header and a teaser. */
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

/** TTL for an anonymous preview (24h). Long enough that a user can come
 * back the next day; short enough to bound memory. */
const TTL_MS = 24 * 60 * 60 * 1000;

/** Hard cap. If the store ever exceeds this we drop the oldest entry
 * before inserting. Bounds memory under an abuse spike. */
const MAX_ENTRIES = 5000;

const STORE = new Map<string, AnonPreviewRecord>();

function now() {
  return Date.now();
}

/** Generate a cryptographically-secure 32-byte base64url token. */
export function newAnonToken(): string {
  return randomBytes(32).toString("base64url");
}

/** Drop expired entries opportunistically. */
function sweep(): void {
  const t = now();
  const toDelete: string[] = [];
  STORE.forEach((v, k) => {
    if (v.expires_at_ms <= t) toDelete.push(k);
  });
  for (const k of toDelete) STORE.delete(k);
}

/** Insert a new anonymous preview. If the store is full, evict the
 * oldest entry first to keep memory bounded. */
export function putAnonPreview(rec: Omit<AnonPreviewRecord, "token" | "expires_at_ms" | "created_at"> & {
  created_at?: string;
}): AnonPreviewRecord {
  if (STORE.size >= MAX_ENTRIES) {
    sweep();
    if (STORE.size >= MAX_ENTRIES) {
      // Evict the oldest by created_at_ms; Map iteration is insertion order.
      const oldest = STORE.keys().next().value;
      if (oldest) STORE.delete(oldest);
    }
  }
  const token = newAnonToken();
  const created_at = rec.created_at ?? new Date().toISOString();
  const record: AnonPreviewRecord = {
    ...rec,
    token,
    created_at,
    expires_at_ms: now() + TTL_MS,
  };
  STORE.set(token, record);
  return record;
}

/** Fetch by token. Returns undefined if missing or expired. Expired
 * entries are dropped on access. */
export function getAnonPreview(token: string): AnonPreviewRecord | undefined {
  if (!token || typeof token !== "string") return undefined;
  const rec = STORE.get(token);
  if (!rec) return undefined;
  if (rec.expires_at_ms <= now()) {
    STORE.delete(token);
    return undefined;
  }
  return rec;
}

/** Single-use claim: returns the record AND removes it from the store.
 * Anyone who already holds the token can attempt to claim it, but the
 * very first successful claim wins and the token is gone afterwards. */
export function consumeAnonPreview(token: string): AnonPreviewRecord | undefined {
  const rec = getAnonPreview(token);
  if (!rec) return undefined;
  STORE.delete(token);
  return rec;
}

/** Build the teaser payload returned to the browser. The full
 * `result_text` is never sent to anonymous clients — they only get
 * the score header, a one-paragraph summary, the top vulnerable
 * tasks, and the names of the locked sections.
 *
 * `buildPreviewPayload` accepts a markdown-extraction function (the
 * one used by the authenticated `/api/analyses` endpoint) so the two
 * paths produce identical-looking teasers. */
export function buildAnonPreviewPayload(
  rec: AnonPreviewRecord,
  extract: (a: { result_text: string }) => {
    summary: string;
    vulnerable_tasks: string[];
    locked_sections: string[];
  },
): AnonPreviewPayload {
  const { summary, vulnerable_tasks, locked_sections } = extract({
    result_text: rec.result_text,
  });
  return {
    token: rec.token,
    created_at: rec.created_at,
    expires_at: new Date(rec.expires_at_ms).toISOString(),
    job_title: rec.job_title,
    automation_risk: rec.automation_risk,
    risk_score: rec.risk_score,
    summary,
    vulnerable_tasks,
    locked_sections,
  };
}

/** Promote an anonymous preview into an authenticated analysis row.
 * The caller (route) is responsible for ownership + lock decisions —
 * this helper just supplies the inputs in the right shape. */
export function anonPreviewToInsertAnalysis(
  rec: AnonPreviewRecord,
  opts: { created_by: number; is_locked: boolean },
): Omit<Analysis, "id"> {
  return {
    created_date: new Date().toISOString(),
    created_by: opts.created_by,
    job_title: rec.job_title,
    job_description: rec.job_description,
    technology_context: rec.technology_context,
    resume_id: null,
    result_text: rec.result_text,
    provider_used: rec.provider_used,
    automation_risk: rec.automation_risk,
    risk_score: rec.risk_score,
    is_locked: opts.is_locked,
  };
}

/** Test helper. */
export function __resetAnonPreviewStore(): void {
  STORE.clear();
}

/** Diagnostic. Never exposed over an API surface — used by verification
 * scripts to sanity-check that abuse caps are working. */
export function __anonPreviewStoreSize(): number {
  return STORE.size;
}
