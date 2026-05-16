/* =====================================================================
 * Lightweight in-memory sliding-window rate limiter
 *
 * Purpose: protect auth-sensitive endpoints (signin, signup, forgot
 * password, reset password, promo redemption, checkout creation/
 * completion, unlock analysis) from credential-stuffing, brute-force,
 * and abuse in a single-process Node deployment.
 *
 * Scope:
 *   - This is an in-process counter keyed by `(scope, key)`. It is
 *     adequate for a single-server preview/production deployment.
 *     Multi-instance deployments must front the app with a shared
 *     limiter (Redis token bucket, CDN/WAF, or a managed gateway).
 *   - We expose two key derivation helpers:
 *       keyByIp(req)          — limit by client IP (proxies honored
 *                                via X-Forwarded-For, first hop only).
 *       keyByEmailAndIp(...)  — combine the submitted email with the
 *                                IP so a single email cannot be
 *                                hammered from many IPs and a single
 *                                IP cannot churn through many emails.
 *
 * Safe errors:
 *   The middleware returns HTTP 429 with a generic message. Callers
 *   never see how many attempts remain — only that they should retry
 *   later. The `Retry-After` header is set so well-behaved clients
 *   back off automatically.
 *
 * Disabling:
 *   Tests can call `__resetRateLimits()` between runs. Set
 *   `DISABLE_RATE_LIMIT=1` to bypass entirely (useful for the existing
 *   regression scripts that hammer endpoints intentionally).
 * ===================================================================== */
import type { Request, Response, NextFunction } from "express";

type Bucket = { count: number; resetAt: number };

const STORE: Map<string, Bucket> = new Map();

function now() {
  return Date.now();
}

function disabledForTests(): boolean {
  return process.env.DISABLE_RATE_LIMIT === "1";
}

/** Drop expired buckets opportunistically so the map doesn't grow
 * unbounded over a long-running process. Called on every check. */
function maybeSweep() {
  if (STORE.size < 1024) return;
  const t = now();
  const toDelete: string[] = [];
  STORE.forEach((b, k) => {
    if (b.resetAt <= t) toDelete.push(k);
  });
  for (const k of toDelete) STORE.delete(k);
}

export interface RateLimitOptions {
  /** Bucket name used as a key prefix — keeps unrelated endpoints
   * from sharing counters. */
  scope: string;
  /** Maximum requests permitted within the window. */
  max: number;
  /** Window length in milliseconds. */
  windowMs: number;
  /** Builds the per-bucket key suffix. Falls back to client IP. */
  keyFn?: (req: Request) => string;
}

/** Extract the client IP. Honors a single hop of X-Forwarded-For when
 * present (Express is typically behind a known reverse proxy in
 * production). Falls back to `req.ip` and finally to a constant so a
 * missing IP cannot bypass rate limiting. */
export function clientIp(req: Request): string {
  const xff = req.headers["x-forwarded-for"];
  if (typeof xff === "string" && xff.length > 0) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  return req.ip || req.socket?.remoteAddress || "unknown";
}

export function keyByIp(req: Request): string {
  return clientIp(req);
}

export function keyByEmailAndIp(getEmail: (req: Request) => string | undefined) {
  return (req: Request) => {
    const ip = clientIp(req);
    const email = (getEmail(req) ?? "").trim().toLowerCase();
    return `${ip}|${email}`;
  };
}

/** Returns Express middleware that enforces the rate limit. */
export function rateLimit(opts: RateLimitOptions) {
  const keyFn = opts.keyFn ?? keyByIp;
  return function rateLimitMiddleware(req: Request, res: Response, next: NextFunction) {
    if (disabledForTests()) return next();
    const t = now();
    const key = `${opts.scope}|${keyFn(req)}`;
    let bucket = STORE.get(key);
    if (!bucket || bucket.resetAt <= t) {
      bucket = { count: 0, resetAt: t + opts.windowMs };
      STORE.set(key, bucket);
    }
    bucket.count += 1;
    maybeSweep();
    if (bucket.count > opts.max) {
      const retryAfterSec = Math.max(1, Math.ceil((bucket.resetAt - t) / 1000));
      res.setHeader("Retry-After", String(retryAfterSec));
      return res.status(429).json({
        error: "Too many requests. Please wait a moment and try again.",
      });
    }
    next();
  };
}

/** Test helper — clears all in-memory counters. Not exported to
 * untrusted callers; only used by verification scripts. */
export function __resetRateLimits(): void {
  STORE.clear();
}
