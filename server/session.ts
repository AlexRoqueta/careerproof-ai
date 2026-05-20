/* =====================================================================
 * Session middleware
 *
 * Replaces the previous server-wide globalThis singleton with real
 * per-client sessions backed by express-session + a signed cookie.
 *
 * Approach:
 *   - express-session sets a signed httpOnly cookie that identifies the
 *     session record server-side. The cookie carries no user data — only
 *     the session id — so credentials never travel in the cookie payload.
 *   - The session store is `memorystore` (an LRU-capped, leak-safe
 *     replacement for the default express MemoryStore that ships a
 *     warning in production). Single-instance Render deploys are the
 *     target topology; multi-instance setups should swap this for a
 *     shared store (Redis, Postgres) — `createSessionMiddleware` is the
 *     single seam to do that.
 *   - Cookies are `httpOnly` (no JS access), `sameSite: "lax"` (CSRF
 *     mitigation while allowing top-level navigation), and `secure: true`
 *     in production (only sent over HTTPS). `trust proxy` in
 *     server/index.ts ensures the secure flag works behind Render's
 *     TLS-terminating proxy.
 *   - SESSION_SECRET is read from env. In preview a stable random
 *     fallback is generated at startup so HMR doesn't invalidate all
 *     sessions on every reload; production logs a loud warning if
 *     SESSION_SECRET is unset.
 * ===================================================================== */
import session from "express-session";
import createMemoryStore from "memorystore";
import { randomBytes } from "node:crypto";
import type { RequestHandler } from "express";

declare module "express-session" {
  interface SessionData {
    user_id?: number;
  }
}

const MemoryStore = createMemoryStore(session);

function resolveSecret(): string {
  const fromEnv = process.env.SESSION_SECRET?.trim();
  if (fromEnv && fromEnv.length >= 16) return fromEnv;
  if (process.env.NODE_ENV === "production") {
    console.warn(
      "[session] SESSION_SECRET is unset or too short in production — generating an ephemeral secret. Sessions will be invalidated on every restart. Set SESSION_SECRET to a long random string (32+ bytes) in the Render env.",
    );
  }
  // Generate a strong fallback so the app boots without env wiring in
  // preview / first deploy. Logged-in users will be signed out on every
  // process restart in this mode, which is acceptable for preview.
  return randomBytes(48).toString("hex");
}

export function createSessionMiddleware(): RequestHandler {
  const isProd = process.env.NODE_ENV === "production";
  return session({
    name: "cp.sid",
    secret: resolveSecret(),
    resave: false,
    saveUninitialized: false,
    rolling: true,
    store: new MemoryStore({
      // Prune expired entries hourly. checkPeriod is in ms.
      checkPeriod: 60 * 60 * 1000,
    }),
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: isProd,
      // 30-day rolling session. `rolling: true` above bumps the expiry
      // on every authenticated request so an active user stays signed
      // in indefinitely.
      maxAge: 30 * 24 * 60 * 60 * 1000,
    },
  });
}
