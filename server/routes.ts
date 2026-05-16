import type { Express, Request, Response } from "express";
import type { Server } from "node:http";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { storage } from "./storage";
import {
  analyzeRequestSchema,
  autofillRequestSchema,
  uploadResumeSchema,
  setCreditsSchema,
  createCheckoutSchema,
  prefillFromResumeSchema,
  redeemPromoCodeSchema,
  signInRequestSchema,
  signUpRequestSchema,
  setPasswordRequestSchema,
  forgotPasswordRequestSchema,
  resetPasswordRequestSchema,
  linkedinImportSchema,
} from "@shared/schema";
import { hashPassword, verifyPassword } from "./password";
import { randomInt } from "node:crypto";
import {
  FREE_CREDITS_PROMO_AMOUNT,
  FREE_CREDITS_PROMO_CODE,
  hasUnlimitedCredits,
  CREDIT_PACKAGES,
  findCreditPackage,
} from "@shared/entitlements";
import { paymentProvider } from "./payments";
import type { CreditTransaction } from "@shared/schema";
import {
  generateAnalysis,
  generateAutofill,
  prefillFromResumeText,
  parseLinkedInJobText,
  extractLinkedInJobWithAI,
  finalizeLinkedInResult,
  looksLikeLoggedOutPreview,
  toTitleCase,
} from "./ai";
import type { Analysis } from "@shared/schema";
import { rateLimit, keyByIp, keyByEmailAndIp } from "./rate-limit";
import { getConfigReport } from "./config";
import { sendPasswordResetEmail, selectEmailProvider } from "./email";

/* Server-side redaction for locked analyses.
 *
 * Defense-in-depth: even though the frontend visually blurs body content for
 * locked reports, the unredacted markdown must never travel over the wire
 * for a non-entitled viewer — anyone with devtools could otherwise read it
 * straight out of the JSON response. We strip the readable body and keep
 * only the document scaffolding (H1/H2/H3 section titles, horizontal rules)
 * so the UI can still render the header, score, and section structure.
 *
 * The replacement body is a fixed redaction marker so the UI's blur is
 * applied to content that has no informational value if revealed. */
const LOCKED_BODY_PLACEHOLDER =
  "\u2588\u2588\u2588\u2588\u2588 \u2588\u2588\u2588\u2588\u2588\u2588\u2588 \u2588\u2588\u2588\u2588 \u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588 \u2588\u2588\u2588 \u2588\u2588\u2588\u2588\u2588 \u2588\u2588\u2588\u2588\u2588\u2588";

function redactLockedMarkdown(md: string): string {
  const lines = md.split(/\r?\n/);
  const out: string[] = [];
  let pendingPlaceholder = false;
  const flushPlaceholder = () => {
    if (pendingPlaceholder) {
      out.push(LOCKED_BODY_PLACEHOLDER);
      out.push("");
      pendingPlaceholder = false;
    }
  };
  for (const raw of lines) {
    const line = raw;
    const trimmed = line.trim();
    if (!trimmed) {
      flushPlaceholder();
      out.push("");
      continue;
    }
    if (/^#{1,3}\s/.test(trimmed) || /^---+$/.test(trimmed)) {
      flushPlaceholder();
      // Strip inline bold/italic markers from headings so the redacted
      // section titles don't leak score values via **High** etc.
      const safe = trimmed.replace(/\*\*([^*]+)\*\*/g, "$1").replace(/(^|[^*])\*([^*]+)\*/g, "$1$2");
      out.push(safe);
      continue;
    }
    // Any non-heading, non-rule line collapses to a single placeholder
    // paragraph per contiguous body block.
    pendingPlaceholder = true;
  }
  flushPlaceholder();
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function sanitizeAnalysisForResponse(a: Analysis): Analysis {
  if (!a.is_locked) return a;
  return { ...a, result_text: redactLockedMarkdown(a.result_text) };
}

/* Build a best-effort absolute URL for the current site from a request.
 * Used by transactional emails when APP_BASE_URL is not set explicitly
 * (preview / local dev). server/index.ts sets `trust proxy`, so
 * req.protocol reflects the public scheme behind a TLS-terminating
 * proxy. Returns undefined when no host header is available. */
function inferBaseUrlFromRequest(req: Request): string | undefined {
  const host = req.get("host");
  if (!host) return undefined;
  const proto = req.protocol || "https";
  return `${proto}://${host}`;
}

/* Parse the loopback URL the preview provider builds so the client can
 * complete the purchase inline (without a same-window hash redirect).
 * The preview provider sets `status=preview-success&session_id=...&token=...`
 * as the URL search part. We only forward the verification fields a
 * live provider would never expose, so live providers never trigger
 * this helper. Returns null if the URL is malformed. */
function extractPreviewSessionFromCheckoutUrl(
  checkoutUrl: string,
): { session_id: string; token: string } | null {
  try {
    const u = new URL(checkoutUrl);
    // The preview provider stuffs the verification fields into the URL
    // search; if the success_url itself contained a `#`, the fields
    // land in the hash instead. Read both, prefer search.
    const params = u.search
      ? u.searchParams
      : u.hash
        ? new URLSearchParams(u.hash.replace(/^#\??/, "").split("?").pop() ?? "")
        : new URLSearchParams();
    const session_id = params.get("session_id") ?? "";
    const token = params.get("token") ?? "";
    if (!session_id || !token) return null;
    return { session_id, token };
  } catch {
    return null;
  }
}

/* Strip password_hash before sending a User over the wire. The stored
 * scrypt hash is not directly reversible, but it is still credential
 * material and should never leak to the browser — returning it would let
 * an attacker take an offline copy and brute-force passwords with
 * unlimited time. */
function sanitizeUserForResponse<T extends { password_hash?: string | null } | undefined>(u: T): T {
  if (!u) return u;
  const { password_hash: _ph, ...rest } = u as any;
  return rest as T;
}

/* In-memory mapping: tracks the currently "logged in" user id.
 * `null` means "no active session" — clients see 401 from /api/me and the
 * frontend renders the sign-in / create-account screen. Production auth
 * can be any best-fit provider. Replace this demo state with session/JWT
 * middleware that resolves the authenticated user.
 *
 * Stored on `globalThis` so HMR/dev reloads of this module don't silently
 * resurrect a stale session. */
const SESSION_KEY = Symbol.for("ousted.currentUserId");
const globalAny = globalThis as any;
if (!(SESSION_KEY in globalAny)) globalAny[SESSION_KEY] = null;
function getCurrentUserId(): number | null {
  return globalAny[SESSION_KEY] ?? null;
}
function setCurrentUserId(id: number | null) {
  globalAny[SESSION_KEY] = id;
}

/* Resolve the active user for owner-gating decisions. Returns the
 * full user row if the session is valid and the user still exists,
 * or null otherwise. Always-fresh lookup so role changes (admin
 * promotion / demotion) take effect immediately. */
async function getActor(): Promise<{ id: number; role: string; email: string } | null> {
  const id = getCurrentUserId();
  if (id == null) return null;
  const u = await storage.getUser(id);
  if (!u) return null;
  return { id: u.id, role: u.role, email: u.email };
}

/* Owner-or-admin gate for analyses + resumes.
 *
 * Design rule: lookup-by-id endpoints (GET/DELETE /api/analyses/:id,
 * unlock, etc.) collapse "not found" and "not yours" into the same
 * 404 — a stranger probing the API cannot distinguish "this id exists
 * but is not yours" from "this id does not exist at all". Admins are
 * always allowed through so support tooling can inspect any record.
 *
 * The actual checks are inlined at each call site to keep the route
 * handler's intent obvious. `getActor` resolves the current session
 * to a fresh user row so role changes take effect immediately. */

function extractPdfTextFromDataUrl(dataUrl: string): string | null {
  const match = dataUrl.match(/^data:application\/pdf[^,]*,([a-z0-9+/=]+)$/i);
  if (!match) return null;
  const dir = mkdtempSync(join(tmpdir(), "resume-pdf-"));
  const pdfPath = join(dir, "resume.pdf");
  try {
    writeFileSync(pdfPath, Buffer.from(match[1], "base64"));
    const text = execFileSync("pdftotext", ["-layout", pdfPath, "-"], {
      encoding: "utf8",
      timeout: 8000,
      maxBuffer: 1024 * 1024,
    });
    const cleaned = text.replace(/\s+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
    return cleaned.length > 40 ? cleaned.slice(0, 12000) : null;
  } catch {
    return null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export async function registerRoutes(httpServer: Server, app: Express): Promise<Server> {
  /* ----- Rate limiters for auth-sensitive endpoints -----
   * Defined up-front so every route handler below can attach the
   * appropriate limiter as middleware. Numbers are tuned for a single-
   * process preview/server: tight enough to deter credential-stuffing
   * and accidental loops, loose enough that a legitimate user who
   * mistypes a few times is not blocked. Multi-instance production
   * deployments should front the app with a shared limiter (Redis
   * token bucket, CDN/WAF, or managed gateway). */
  const limitSignin = rateLimit({
    scope: "signin",
    max: 10,
    windowMs: 60_000,
    keyFn: keyByEmailAndIp((r) => String(r.body?.email ?? "")),
  });
  const limitSignup = rateLimit({ scope: "signup", max: 5, windowMs: 60_000, keyFn: keyByIp });
  const limitForgot = rateLimit({
    scope: "forgot",
    max: 5,
    windowMs: 60_000,
    keyFn: keyByEmailAndIp((r) => String(r.body?.email ?? "")),
  });
  const limitReset = rateLimit({
    scope: "reset",
    max: 10,
    windowMs: 60_000,
    keyFn: keyByEmailAndIp((r) => String(r.body?.email ?? "")),
  });
  const limitSetPassword = rateLimit({ scope: "set-password", max: 5, windowMs: 60_000, keyFn: keyByIp });
  const limitPromo = rateLimit({ scope: "promo", max: 10, windowMs: 60_000, keyFn: keyByIp });
  const limitCheckoutCreate = rateLimit({ scope: "checkout-create", max: 20, windowMs: 60_000, keyFn: keyByIp });
  const limitCheckoutComplete = rateLimit({ scope: "checkout-complete", max: 30, windowMs: 60_000, keyFn: keyByIp });
  const limitUnlock = rateLimit({ scope: "unlock", max: 20, windowMs: 60_000, keyFn: keyByIp });
  const limitLinkedinImport = rateLimit({
    scope: "linkedin-import",
    max: 10,
    windowMs: 60_000,
    keyFn: keyByIp,
  });

  /* --------------- Identity / Auth simulation --------------- */
  app.get("/api/me", async (_req: Request, res: Response) => {
    const id = getCurrentUserId();
    if (id == null) return res.status(401).json({ error: "Not signed in" });
    const user = await storage.getUser(id);
    if (!user) {
      // Session points at a user that no longer exists — clear it.
      setCurrentUserId(null);
      return res.status(401).json({ error: "Not signed in" });
    }
    res.json(sanitizeUserForResponse(user));
  });

  // Generic credentials-error message used for unknown-email AND
  // wrong-password to avoid leaking which one was wrong. Returned with
  // HTTP 401 (Unauthorized).
  const INVALID_CREDENTIALS = "Invalid email or password";

  app.post("/api/me/signin", limitSignin, async (req: Request, res: Response) => {
    const parsed = signInRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Email and password are required" });
    }
    const email = parsed.data.email.trim().toLowerCase();
    const password = parsed.data.password;
    const user = await storage.getUserByEmail(email);
    if (!user) {
      // Run a dummy verify to keep response timing close to the valid
      // path. Result is ignored.
      verifyPassword(password, "scrypt$16384$8$1$00$00");
      return res.status(401).json({ error: INVALID_CREDENTIALS });
    }
    if (!user.password_hash) {
      // Account exists but has never had a password set. Surface a
      // distinct status so the client can offer the first-time password
      // setup flow. The response intentionally does not confirm whether
      // the account is genuinely password-less to anyone who doesn't
      // already know the email — the email had to be valid to land here.
      return res.status(409).json({
        error: "This account has no password set yet. Set a password to continue.",
        needs_password_setup: true,
      });
    }
    if (!verifyPassword(password, user.password_hash)) {
      return res.status(401).json({ error: INVALID_CREDENTIALS });
    }
    setCurrentUserId(user.id);
    res.json(sanitizeUserForResponse(user));
  });

  app.post("/api/me/signup", limitSignup, async (req: Request, res: Response) => {
    const parsed = signUpRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      // Surface the first validation message so the inline alert is
      // useful even though the client also runs the same schema.
      const first = parsed.error.issues[0];
      return res.status(400).json({ error: first?.message ?? "Invalid input" });
    }
    const full_name = parsed.data.full_name.trim();
    const email = parsed.data.email.trim().toLowerCase();
    if (await storage.getUserByEmail(email)) {
      return res.status(409).json({ error: "An account with that email already exists" });
    }
    // New accounts start with zero credits. Entitlement to a free quota
    // (promo codes, unlimited-list, admin role) is granted explicitly
    // elsewhere — never as a side effect of account creation. A zero-credit
    // user can still run analyses, but every report they generate is saved
    // with is_locked=true so the readable body is gated until they buy
    // credits or are otherwise entitled.
    const user = await storage.createUser({
      full_name,
      email,
      role: "user",
      credits: 0,
      created_date: new Date().toISOString(),
      password_hash: hashPassword(parsed.data.password),
    });
    setCurrentUserId(user.id);
    res.json(sanitizeUserForResponse(user));
  });

  /* =====================================================================
   * Password reset flow (lost password)
   *
   * Design notes:
   *   - /forgot-password always returns the same generic 200 body for
   *     valid input, whether or not the email matches a real account.
   *     This prevents an attacker from probing /forgot-password to
   *     enumerate which emails exist.
   *   - Reset codes are 6-digit zero-padded strings, generated with
   *     crypto.randomInt so they don't leak about the system PRNG.
   *   - The code is hashed with scrypt before storage (same helper as
   *     password_hash) so a leaked password_resets table does not
   *     directly hand out usable codes.
   *   - Codes expire 30 minutes after issue and are single-use. On
   *     successful reset the user is signed in and ALL other active
   *     codes for that user are invalidated.
   *   - There is intentionally no "reset code with no new password"
   *     endpoint. You cannot use the reset flow to bypass the password
   *     prompt and sign in directly; you must also set a new password
   *     in the same request.
   *
   * Preview affordance:
   *   - This app has no email service. The response includes a
   *     `preview_code` field with the plaintext code when running in
   *     development (NODE_ENV !== "production") OR when the operator
   *     opts in by setting ALLOW_PREVIEW_RESET_CODE=1. Production
   *     deployments should ship with that flag UNSET so the code is
   *     never returned in HTTP responses — the email-sending pipeline
   *     becomes the only way to learn the code.
   * ===================================================================== */
  const RESET_CODE_TTL_MINUTES = 30;
  // Production-safe reset-code surfacing. Codes are only echoed in the
  // HTTP response when:
  //   1. running outside production (NODE_ENV !== "production"), OR
  //   2. the operator explicitly opts in with ALLOW_PREVIEW_RESET_CODE=1.
  // In production with the flag UNSET, the response carries a clear
  // "reset code sent if email service is configured" message and the
  // code is delivered exclusively via the configured email pipeline.
  const PREVIEW_CODE_ENABLED =
    process.env.NODE_ENV !== "production" || process.env.ALLOW_PREVIEW_RESET_CODE === "1";

  function generateResetCode(): string {
    // 6-digit numeric. crypto.randomInt for uniform distribution.
    return String(randomInt(0, 1_000_000)).padStart(6, "0");
  }

  app.post("/api/me/forgot-password", limitForgot, async (req: Request, res: Response) => {
    const parsed = forgotPasswordRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "A valid email is required" });
    }
    const email = parsed.data.email.trim().toLowerCase();
    const user = await storage.getUserByEmail(email);

    // Generic public response — SAME for unknown emails and known
    // emails. The only side effect of an unknown email is no DB write.
    // In production with the email pipeline configured the response
    // explicitly says the code was "sent". In preview mode the response
    // says the code is shown on this page (and includes it inline
    // below). The wording NEVER differs based on whether the email
    // matches an account.
    const productionMessage =
      "If an account with that email exists, a reset code has been sent. Check your email to continue.";
    const previewMessage =
      "If an account with that email exists, a reset code has been generated. (Preview build — the code is shown on this page only because ALLOW_PREVIEW_RESET_CODE=1 or NODE_ENV != production.)";
    const genericResponse: { ok: true; message: string; preview_code?: string } = {
      ok: true,
      message: PREVIEW_CODE_ENABLED ? previewMessage : productionMessage,
    };

    if (user) {
      const code = generateResetCode();
      const now = new Date();
      const expires = new Date(now.getTime() + RESET_CODE_TTL_MINUTES * 60_000);
      await storage.createPasswordReset({
        user_id: user.id,
        code_hash: hashPassword(code),
        created_at: now.toISOString(),
        expires_at: expires.toISOString(),
      });
      // Preview-only affordance — see banner above. Never enabled in
      // a non-preview production build.
      if (PREVIEW_CODE_ENABLED) {
        genericResponse.preview_code = code;
      }
      // Fire-and-await the configured email pipeline. Failures are
      // logged but never surfaced to the caller — the route always
      // returns the same generic 200 to avoid leaking which emails are
      // attached to real accounts. The `delivered` boolean is captured
      // for server logs only.
      const provider = selectEmailProvider();
      if (provider !== "none") {
        try {
          const appBaseUrl = process.env.APP_BASE_URL?.trim() || inferBaseUrlFromRequest(req);
          const result = await sendPasswordResetEmail({
            to: email,
            code,
            ttlMinutes: RESET_CODE_TTL_MINUTES,
            appBaseUrl,
          });
          if (!result.delivered) {
            console.warn(
              `[forgot-password] email send failed via provider=${result.provider} reason=${result.reason ?? "unknown"}`,
            );
          }
        } catch (err) {
          // Never let an email failure break the generic 200 response.
          const reason = err instanceof Error ? err.message : String(err);
          console.error(`[forgot-password] unexpected send error: ${reason}`);
        }
      } else {
        console.warn(
          "[forgot-password] no email provider configured — reset code will not be delivered. Set EMAIL_PROVIDER=resend (plus EMAIL_API_KEY and EMAIL_FROM) or RESET_DELIVERY_MODE=log.",
        );
      }
    }
    res.json(genericResponse);
  });

  app.post("/api/me/reset-password", limitReset, async (req: Request, res: Response) => {
    const parsed = resetPasswordRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      return res.status(400).json({ error: first?.message ?? "Invalid input" });
    }
    const email = parsed.data.email.trim().toLowerCase();
    const submittedCode = parsed.data.code.trim();

    // Same generic 400 — do not differentiate "unknown email" from
    // "wrong code" or "expired code". The only signal a caller gets is
    // "the reset code is invalid or has expired".
    const INVALID = { error: "Reset code is invalid or has expired" };

    const user = await storage.getUserByEmail(email);
    if (!user) {
      // Run a dummy verify to flatten timing.
      verifyPassword(submittedCode, "scrypt$16384$8$1$00$00");
      return res.status(400).json(INVALID);
    }

    const active = await storage.listActivePasswordResetsForUser(user.id);
    const now = Date.now();
    let matched: (typeof active)[number] | undefined;
    for (const r of active) {
      const expiresMs = Date.parse(r.expires_at);
      if (!Number.isFinite(expiresMs) || expiresMs < now) continue;
      if (verifyPassword(submittedCode, r.code_hash)) {
        matched = r;
        break;
      }
    }
    if (!matched) {
      return res.status(400).json(INVALID);
    }

    const usedAt = new Date().toISOString();
    await storage.markPasswordResetUsed(matched.id, usedAt);
    // Invalidate any other still-active codes for the same user so a
    // previously requested code cannot be redeemed after the password
    // has already been reset.
    await storage.invalidateOtherPasswordResets(user.id, matched.id, usedAt);

    const updated = await storage.setUserPassword(user.id, hashPassword(parsed.data.password));
    if (!updated) return res.status(500).json({ error: "Failed to reset password" });

    setCurrentUserId(updated.id);
    res.json(sanitizeUserForResponse(updated));
  });

  app.post("/api/me/set-password", limitSetPassword, async (req: Request, res: Response) => {
    // First-time password setup for an existing account that has no
    // password_hash. We only allow this when the account currently has
    // no password. Setting/changing a password for an account that
    // already has one would require knowing the current password and is
    // out of scope for this preview.
    const parsed = setPasswordRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      return res.status(400).json({ error: first?.message ?? "Invalid input" });
    }
    const email = parsed.data.email.trim().toLowerCase();
    const user = await storage.getUserByEmail(email);
    if (!user) return res.status(404).json({ error: "No account found for that email" });
    if (user.password_hash) {
      return res
        .status(409)
        .json({ error: "This account already has a password. Sign in to continue." });
    }
    const updated = await storage.setUserPassword(user.id, hashPassword(parsed.data.password));
    if (!updated) return res.status(500).json({ error: "Failed to set password" });
    setCurrentUserId(updated.id);
    res.json(sanitizeUserForResponse(updated));
  });

  app.post("/api/me/switch", async (req: Request, res: Response) => {
    // Admin-only utility, gated by the current session.
    const meId = getCurrentUserId();
    const me = meId != null ? await storage.getUser(meId) : undefined;
    if (!me || me.role !== "admin") return res.status(403).json({ error: "Admin only" });
    const id = Number(req.body?.user_id);
    const user = await storage.getUser(id);
    if (!user) return res.status(404).json({ error: "User not found" });
    setCurrentUserId(id);
    res.json(sanitizeUserForResponse(user));
  });

  app.post("/api/me/logout", (_req: Request, res: Response) => {
    // Clears the in-memory session. In production this would also clear
    // the session cookie / token.
    setCurrentUserId(null);
    res.json({ ok: true });
  });

  /* --------------- Admin --------------- */
  app.get("/api/users", async (_req: Request, res: Response) => {
    const meId = getCurrentUserId();
    const me = meId != null ? await storage.getUser(meId) : undefined;
    if (!me || me.role !== "admin") return res.status(403).json({ error: "Admin only" });
    const all = await storage.listUsers();
    res.json(all.map(sanitizeUserForResponse));
  });

  app.post("/api/users/set-credits", async (req: Request, res: Response) => {
    const meId = getCurrentUserId();
    const me = meId != null ? await storage.getUser(meId) : undefined;
    if (!me || me.role !== "admin") return res.status(403).json({ error: "Admin only" });
    const parsed = setCreditsSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
    const target = await storage.getUser(parsed.data.user_id);
    if (!target) return res.status(404).json({ error: "User not found" });
    const previous = target.credits;
    const next = parsed.data.credits;
    const updated = await storage.setUserCredits(parsed.data.user_id, next);
    if (!updated) return res.status(404).json({ error: "User not found" });
    // Admin balance changes are recorded as a single delta on the
    // ledger so the transaction history is complete. A no-op set
    // (same value) skips the ledger row.
    if (next !== previous) {
      await storage.appendCreditTransaction({
        user_id: target.id,
        amount_delta: next - previous,
        balance_after: next,
        reason: "admin_adjustment",
        reference: `admin:${me.email}`,
        provider: null,
        created_at: new Date().toISOString(),
      });
    }
    res.json(sanitizeUserForResponse(updated));
  });

  /* --------------- Resumes --------------- */
  app.get("/api/resumes", async (_req: Request, res: Response) => {
    const id = getCurrentUserId();
    if (id == null) return res.status(401).json({ error: "Not signed in" });
    res.json(await storage.listResumes(id));
  });

  app.post("/api/resumes", async (req: Request, res: Response) => {
    const id = getCurrentUserId();
    if (id == null) return res.status(401).json({ error: "Not signed in" });
    const parsed = uploadResumeSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
    const { filename, content_type, size_bytes, data_url } = parsed.data;

    // === BOUNDARY: real extraction service ===
    // In production: POST file to a parsing service (Textract, Apryse,
    // pdf-parse, mammoth, etc.) and store the extracted text. Here we
    // generate a plausible, deterministic stub from the filename.
    const base = filename.replace(/\.[^.]+$/, "").replace(/[_\-]+/g, " ");
    const extractedFromPdf = extractPdfTextFromDataUrl(data_url);
    const extracted_text =
      extractedFromPdf ??
      `${base}\nSenior Professional with multi-year experience across product, technology, and client-facing roles.\n\nSelected Experience\n• Led cross-functional initiatives delivering measurable outcomes.\n• Collaborated with engineering, design, and operations stakeholders.\n• Owned reporting, planning, and quality assurance for major workstreams.\n\nSkills\n• Communication, project management, analytical thinking, AI-assisted workflows.\n\nEducation\n• Bachelor's degree, relevant field.\n\n(Extracted text generated by the in-app fallback. Upload a text-readable PDF for more specific resume parsing.)`;

    const resume = await storage.createResume({
      created_date: new Date().toISOString(),
      created_by: id,
      filename,
      content_type,
      // Store the data: URL directly. For real production storage, swap
      // this for an S3 key + signed URL.
      file_url: data_url,
      extracted_text,
      size_bytes,
    });
    res.json(resume);
  });

  app.delete("/api/resumes/:id", async (req: Request, res: Response) => {
    const actor = await getActor();
    if (!actor) return res.status(401).json({ error: "Not signed in" });
    const id = Number(req.params.id);
    const r = await storage.getResume(id);
    if (!r) return res.status(404).json({ error: "Not found" });
    if (r.created_by !== actor.id && actor.role !== "admin") {
      return res.status(404).json({ error: "Not found" });
    }
    await storage.deleteResume(id);
    res.json({ ok: true });
  });

  app.post("/api/resumes/prefill", async (req: Request, res: Response) => {
    const actor = await getActor();
    if (!actor) return res.status(401).json({ error: "Not signed in" });
    const parsed = prefillFromResumeSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
    const resume = await storage.getResume(parsed.data.resume_id);
    if (!resume) return res.status(404).json({ error: "Resume not found" });
    if (resume.created_by !== actor.id && actor.role !== "admin") {
      return res.status(404).json({ error: "Resume not found" });
    }
    const extractedFromStoredPdf = extractPdfTextFromDataUrl(resume.file_url);
    const sourceText = `${resume.filename}\n${extractedFromStoredPdf ?? resume.extracted_text}`;
    res.json(prefillFromResumeText(sourceText));
  });

  /* --------------- AI helpers --------------- */
  app.post("/api/autofill", (req: Request, res: Response) => {
    const parsed = autofillRequestSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
    res.json(generateAutofill(parsed.data.job_title));
  });

  /* --------------- LinkedIn job import ---------------
   *
   * LinkedIn does not offer a stable public scrape surface. Most
   * server-side fetches against a job URL return an auth wall or a
   * heavily-redacted shell. The endpoint therefore:
   *
   *   1. Trusts pasted text first — that's the supported path. If the
   *      caller provides `pasted_text`, the URL fetch is skipped.
   *   2. Otherwise attempts a single GET against the URL on a short
   *      timeout (default 6s) with a generic User-Agent. The response
   *      body is parsed for a JSON-LD JobPosting block (the most
   *      reliable signal when available) and then for visible text.
   *   3. Always returns 200 with `{ source, parsed, warning? }`. The
   *      `source` field is one of "pasted" | "fetch" | "fetch-failed".
   *      A `fetch-failed` source surfaces a warning string the UI shows
   *      to nudge the user toward the paste / manual fallback.
   *
   * No LinkedIn credentials are accepted, sent, or stored. */
  app.post("/api/linkedin/import", limitLinkedinImport, async (req: Request, res: Response) => {
    const parsed = linkedinImportSchema.safeParse(req.body);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      return res.status(400).json({ error: first?.message ?? "Invalid input" });
    }
    const url = parsed.data.url?.trim() ?? "";
    const pasted = parsed.data.pasted_text?.trim() ?? "";

    // Pasted text is the primary supported path. Try AI extraction first
    // when a provider is configured; the helper internally falls back to
    // the heuristic parser if the LLM is unavailable, times out, or
    // returns malformed output, so this call never throws.
    if (pasted) {
      const result = await extractLinkedInJobWithAI(pasted);
      // Heuristic: did the paste look like a logged-out preview only?
      // We flag a soft UI warning if no real Experience block was found
      // and the description looks too thin to be useful.
      const previewWarning = looksLikeLoggedOutPreview(pasted, result)
        ? "This looks like LinkedIn's logged-out preview — open the full profile, expand About and Experience, then copy again for a richer import. We still extracted what we could."
        : undefined;
      return res.json({
        source: "pasted",
        engine: result.source_engine,
        parsed: {
          job_title: result.job_title,
          company: result.company,
          location: result.location,
          job_description: result.job_description,
          technology_context: result.technology_context ?? "",
          employment_type: result.employment_type ?? "",
          seniority: result.seniority ?? "",
        },
        ...(result.ai_error ? { ai_warning: "Used heuristic fallback for paste extraction." } : {}),
        ...(previewWarning ? { warning: previewWarning } : {}),
      });
    }

    // URL-only path: attempt a best-effort fetch. We never throw on
    // failure — the UI is expected to gracefully fall back to manual
    // entry or pasted-text input.
    if (!url) {
      // Defensive: schema refine should have rejected this already.
      return res.status(400).json({ error: "Provide a LinkedIn URL or paste the job text." });
    }

    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch {
      return res.status(400).json({ error: "That doesn't look like a valid URL." });
    }
    if (!/^https?:$/.test(parsedUrl.protocol)) {
      return res.status(400).json({ error: "URL must be http or https." });
    }
    if (!/(^|\.)linkedin\.com$/i.test(parsedUrl.hostname)) {
      return res.status(400).json({
        error: "URL must be a LinkedIn job link (linkedin.com).",
      });
    }

    const controller = new AbortController();
    const timeoutMs = 6000;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const upstream = await fetch(parsedUrl.toString(), {
        method: "GET",
        redirect: "follow",
        signal: controller.signal,
        headers: {
          "User-Agent":
            "Mozilla/5.0 (compatible; CareerProofAI/1.0; +https://careerproof.ai)",
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.5",
        },
      });
      clearTimeout(timer);
      if (!upstream.ok) {
        return res.json({
          source: "fetch-failed",
          engine: "heuristic",
          parsed: { job_title: "", company: "", location: "", job_description: "", technology_context: "", employment_type: "", seniority: "" },
          warning:
            `LinkedIn responded with HTTP ${upstream.status}. Paste the job text from LinkedIn into the box below instead — it works reliably.`,
        });
      }
      const contentType = upstream.headers.get("content-type") ?? "";
      if (!/text\/html|application\/xhtml/i.test(contentType)) {
        return res.json({
          source: "fetch-failed",
          engine: "heuristic",
          parsed: { job_title: "", company: "", location: "", job_description: "", technology_context: "", employment_type: "", seniority: "" },
          warning:
            "LinkedIn didn't return a readable HTML page. Paste the job text from LinkedIn into the box below instead.",
        });
      }
      // Cap the read so a giant page (or a redirect to a feed) doesn't
      // waste memory. 1.5MB is plenty for a job posting.
      const buf = await upstream
        .clone()
        .arrayBuffer()
        .then((b) => Buffer.from(b).slice(0, 1_500_000).toString("utf8"));
      const fetched = parseLinkedInJobText(buf);
      const usable =
        Boolean(fetched.job_title) ||
        (fetched.job_description && fetched.job_description.length > 80);
      if (!usable) {
        return res.json({
          source: "fetch-failed",
          engine: "heuristic",
          parsed: {
            job_title: fetched.job_title,
            company: fetched.company,
            location: fetched.location,
            job_description: fetched.job_description,
            technology_context: "",
            employment_type: "",
            seniority: "",
          },
          warning:
            "We reached LinkedIn but couldn't read the job details (LinkedIn likely showed a sign-in wall). Paste the job text from LinkedIn into the box below instead.",
        });
      }
      // Run AI extraction on the fetched text too — it's the same shape
      // the paste path sees. The helper falls back to the heuristic
      // result on any failure.
      const enriched = await extractLinkedInJobWithAI(buf);
      // Final sanitization: every field gets the description / short-
      // field cleaner once more before being returned.
      const merged = finalizeLinkedInResult(
        {
          job_title: enriched.job_title || fetched.job_title,
          company: enriched.company || fetched.company,
          location: enriched.location || fetched.location,
          job_description: enriched.job_description || fetched.job_description,
          technology_context: enriched.technology_context,
          employment_type: enriched.employment_type,
          seniority: enriched.seniority,
        },
        enriched.source_engine,
      );
      return res.json({
        source: "fetch",
        engine: merged.source_engine,
        parsed: {
          job_title: merged.job_title,
          company: merged.company,
          location: merged.location,
          job_description: merged.job_description,
          technology_context: merged.technology_context ?? "",
          employment_type: merged.employment_type ?? "",
          seniority: merged.seniority ?? "",
        },
      });
    } catch (err: any) {
      clearTimeout(timer);
      const aborted = err?.name === "AbortError";
      return res.json({
        source: "fetch-failed",
        parsed: { job_title: "", company: "", location: "", job_description: "" },
        warning: aborted
          ? "Fetching the LinkedIn page timed out. Paste the job text from LinkedIn into the box below instead."
          : "We couldn't fetch that LinkedIn URL. Paste the job text from LinkedIn into the box below instead.",
      });
    }
  });

  /* --------------- Analyses --------------- */
  app.get("/api/analyses", async (_req: Request, res: Response) => {
    const id = getCurrentUserId();
    if (id == null) return res.status(401).json({ error: "Not signed in" });
    const list = await storage.listAnalyses(id);
    res.json(list.map(sanitizeAnalysisForResponse));
  });

  app.get("/api/analyses/:id", async (req: Request, res: Response) => {
    const actor = await getActor();
    if (!actor) return res.status(401).json({ error: "Not signed in" });
    const id = Number(req.params.id);
    const a = await storage.getAnalysis(id);
    // Collapse "not found" and "not yours" into the same 404 so an
    // attacker cannot enumerate analysis ids belonging to other users.
    if (!a) return res.status(404).json({ error: "Not found" });
    if (a.created_by !== actor.id && actor.role !== "admin") {
      return res.status(404).json({ error: "Not found" });
    }
    res.json(sanitizeAnalysisForResponse(a));
  });

  app.delete("/api/analyses/:id", async (req: Request, res: Response) => {
    const actor = await getActor();
    if (!actor) return res.status(401).json({ error: "Not signed in" });
    const id = Number(req.params.id);
    const a = await storage.getAnalysis(id);
    if (!a) return res.status(404).json({ error: "Not found" });
    if (a.created_by !== actor.id && actor.role !== "admin") {
      return res.status(404).json({ error: "Not found" });
    }
    await storage.deleteAnalysis(id);
    res.json({ ok: true });
  });

  /* Unlock a previously locked analysis by consuming exactly one credit.
   * Unlimited accounts (admin or entitled email) unlock for free and
   * do NOT generate a ledger row — entitlement is a separate concept
   * from the credit balance.
   *
   * Paying users with zero credits get a 402 with a clear, actionable
   * error so the frontend can route them to the Buy Credits flow. */
  app.post("/api/analyses/:id/unlock", limitUnlock, async (req: Request, res: Response) => {
    const id = Number(req.params.id);
    const meId = getCurrentUserId();
    const me = meId != null ? await storage.getUser(meId) : undefined;
    if (!me) return res.status(401).json({ error: "Not signed in" });
    const analysis = await storage.getAnalysis(id);
    // Owner-or-admin gate. A non-owner unlocking another user's report
    // must be indistinguishable from "that analysis does not exist" to
    // avoid leaking the id space.
    if (!analysis) return res.status(404).json({ error: "Not found" });
    if (analysis.created_by !== me.id && me.role !== "admin") {
      return res.status(404).json({ error: "Not found" });
    }
    if (!analysis.is_locked) return res.json(analysis); // already unlocked, no-op
    const unlimited = hasUnlimitedCredits(me.email, me.role);
    if (!unlimited && me.credits <= 0) {
      return res.status(402).json({
        error: "You don\u2019t have any credits left. Buy a credit pack to unlock this report.",
        reason: "insufficient_credits",
      });
    }
    if (!unlimited) {
      const updated = await storage.decrementCredits(me.id);
      // Ledger row for the spend — always exactly -1.
      await storage.appendCreditTransaction({
        user_id: me.id,
        amount_delta: -1,
        balance_after: updated?.credits ?? Math.max(0, me.credits - 1),
        reason: "unlock_spend",
        reference: `analysis:${id}`,
        provider: null,
        created_at: new Date().toISOString(),
      });
    }
    const unlocked = await storage.unlockAnalysis(id);
    res.json(unlocked);
  });

  app.post("/api/analyses", async (req: Request, res: Response) => {
    const parsed = analyzeRequestSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
    const meId = getCurrentUserId();
    const me = meId != null ? await storage.getUser(meId) : undefined;
    if (!me) return res.status(401).json({ error: "Not signed in" });

    // Credit gate: admins and specifically entitled emails have unlimited
    // analyses. Regular users without credits still get a generated
    // report, but it is stored with is_locked=1 so the frontend can
    // obfuscate the readable body until they buy credits.
    const unlimited = hasUnlimitedCredits(me.email, me.role);
    const willLock = !unlimited && me.credits <= 0;

    // Allow client to abort mid-flight without treating a normal response
    // lifecycle as cancellation. `res.on("close")` can fire before our
    // async mock LLM finishes in the deployed proxy path, especially after
    // large resume uploads, which produced false 499 "Aborted" failures.
    // `aborted` is the request-side signal for a genuinely interrupted
    // client request.
    const controller = new AbortController();
    req.on("aborted", () => controller.abort());

    let resume_text: string | null = null;
    if (parsed.data.resume_id) {
      const r = await storage.getResume(parsed.data.resume_id);
      if (r) resume_text = r.extracted_text;
    }

    try {
      const out = await generateAnalysis({
        job_title: toTitleCase(parsed.data.job_title),
        job_description: parsed.data.job_description,
        technology_context: parsed.data.technology_context,
        resume_text,
        signal: controller.signal,
      });

      // Deduct credits only for paying users who actually had credits to
      // spend. Locked / unlimited paths skip the decrement.
      if (!unlimited && !willLock) await storage.decrementCredits(me.id);

      const saved = await storage.createAnalysis({
        created_date: new Date().toISOString(),
        created_by: me.id,
        job_title: parsed.data.job_title,
        job_description: parsed.data.job_description,
        technology_context: parsed.data.technology_context ?? null,
        resume_id: parsed.data.resume_id ?? null,
        result_text: out.result_text,
        provider_used: out.provider_used,
        automation_risk: out.automation_risk,
        risk_score: out.risk_score,
        is_locked: willLock,
      });
      // For locked saves, never echo the readable body back to the client.
      // The full markdown is preserved in storage so /unlock can reveal it
      // after a credit is spent or an entitlement is granted.
      res.json(sanitizeAnalysisForResponse(saved));
    } catch (err: any) {
      if (err?.name === "AbortError") {
        return res.status(499).json({ error: "Aborted" });
      }
      console.error(err);
      res.status(500).json({ error: "Analysis failed" });
    }
  });

  /* =====================================================================
   * Payments — provider-agnostic
   *
   * Routes:
   *   GET  /api/payments/packages              — list available packages + provider metadata
   *   POST /api/payments/create-checkout       — create a checkout session, return URL
   *   POST /api/payments/complete-checkout     — verify session + grant credits (preview / loopback)
   *   POST /api/payments/webhook               — production webhook receiver (stub)
   *
   * The active provider is selected by PAYMENT_PROVIDER. The preview
   * provider returns a loopback URL; the live providers (Stripe, Lemon
   * Squeezy) are stubbed until the operator wires credentials.
   * ===================================================================== */
  app.get("/api/payments/packages", (_req: Request, res: Response) => {
    res.json({
      packages: CREDIT_PACKAGES,
      provider: {
        name: paymentProvider.name,
        display_name: paymentProvider.displayName,
        is_preview: paymentProvider.isPreview,
      },
    });
  });

  app.post("/api/payments/create-checkout", limitCheckoutCreate, async (req: Request, res: Response) => {
    const parsed = createCheckoutSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Invalid package" });
    const meId = getCurrentUserId();
    const me = meId != null ? await storage.getUser(meId) : undefined;
    if (!me) return res.status(401).json({ error: "Not signed in" });

    const pkg = findCreditPackage(parsed.data.package_id);
    if (!pkg) return res.status(404).json({ error: "Unknown package" });

    /* Build the public origin the provider redirects back to. Order of
     * preference:
     *   1. APP_BASE_URL env var (authoritative — set on Render etc.).
     *      Required in production per server/config.ts; honored in
     *      preview when present so dev deployments behind a proxy build
     *      correct HTTPS URLs.
     *   2. req.protocol + Host header. Requires `trust proxy` to be set
     *      so the scheme reflects the public (https) protocol behind a
     *      TLS-terminating proxy. server/index.ts sets it.
     *
     * The redirect URL points the buyer back to /#/credits. We pass the
     * provider's session metadata via query, but because wouter's hash
     * router treats `/credits?status=...` as a distinct, unmatched
     * route (it does not strip the search part), the Credits page
     * does the actual completion inline in `checkout.onSuccess` for
     * preview mode. The redirect URL is still issued so a real provider
     * (Stripe) can land the buyer back on the page; the App-level URL
     * watcher in client/src/App.tsx then strips the query and triggers
     * the completion. */
    const explicitBase = (process.env.APP_BASE_URL ?? "").trim().replace(/\/$/, "");
    const origin = explicitBase || `${req.protocol}://${req.get("host") ?? ""}`;
    const success_url = `${origin}/#/credits`;
    const cancel_url = `${origin}/#/credits?status=preview-cancel`;

    try {
      const result = await paymentProvider.createCheckout({
        user_id: me.id,
        user_email: me.email,
        package_id: pkg.id,
        success_url,
        cancel_url,
      });
      /* For Stripe, the webhook is the authoritative grant path. Log
       * the session id so the operator can correlate Stripe Dashboard
       * events with app users when debugging. The session id alone is
       * not sensitive (it's also visible to the buyer in the URL). */
      if (result.provider === "stripe") {
        console.log(
          `[payments] stripe checkout session created session=${result.session_id} user=${me.id} package=${pkg.id}`,
        );
      }
      /* For the preview provider, also surface the signed session
       * fields directly in the JSON response so the client can complete
       * the purchase in the same window — no redirect required. This
       * avoids the hash-query-vs-route-matching pitfall described
       * above. Real providers redirect the browser to a hosted checkout
       * URL and never expose verification material in this response. */
      const previewSession =
        result.preview
          ? extractPreviewSessionFromCheckoutUrl(result.checkout_url)
          : null;
      res.json({
        checkout_url: result.checkout_url,
        session_id: result.session_id,
        package: pkg,
        provider: result.provider,
        preview: result.preview,
        // Only populated when the active provider is the preview stub.
        // Live providers never include a `preview_completion` payload.
        preview_completion: previewSession,
      });
    } catch (err: any) {
      console.error("payments.createCheckout failed", err);
      res.status(500).json({ error: "Failed to start checkout" });
    }
  });

  app.post("/api/payments/complete-checkout", limitCheckoutComplete, async (req: Request, res: Response) => {
    /* The success page on the Credits route POSTs here after the
     * provider redirects the buyer back. Behavior depends on which
     * provider returned the session:
     *
     *   - Preview provider: verify the HMAC token, then grant credits
     *     directly here (the preview flow has no webhook). Idempotency
     *     keyed by the session id in the ledger reference column.
     *
     *   - Stripe (and other live providers): the webhook is the
     *     AUTHORITATIVE grant path. This endpoint only reports whether
     *     the session has paid. If the webhook already fired we return
     *     the new balance; if not we report pending. We NEVER write a
     *     ledger row here for live providers — doing so would race the
     *     webhook and risk double-grants. The Credits page polls
     *     /api/me + /api/credits/transactions so the new balance is
     *     visible as soon as the webhook completes.
     */
    const meId = getCurrentUserId();
    const me = meId != null ? await storage.getUser(meId) : undefined;
    if (!me) return res.status(401).json({ error: "Not signed in" });

    const session_id = String(req.body?.session_id ?? "");
    const token = String(req.body?.token ?? "");
    if (!session_id) return res.status(400).json({ error: "Missing session id" });

    try {
      const verify = await paymentProvider.verifySession({ session_id, token });
      if (!verify.ok || !verify.package) {
        // For Stripe, a not-yet-paid session is the common case when the
        // buyer lands back faster than the webhook fires — surface that
        // as a pending state, not an error, so the client can poll.
        if (paymentProvider.name === "stripe") {
          const current = await storage.getUser(me.id);
          return res.json({
            user: sanitizeUserForResponse(current ?? me),
            credits_added: 0,
            already_processed: false,
            pending: true,
            provider: paymentProvider.name,
          });
        }
        return res.status(400).json({ error: verify.error ?? "Could not verify the purchase" });
      }
      const reference = `${verify.provider}:checkout_session:${session_id}`;
      const legacyReference = `${verify.provider}:${session_id}`;
      // Idempotency — if this session already produced a ledger row,
      // return the current user without granting again.
      const txs = await storage.listCreditTransactions(me.id);
      const existing = txs.find(
        (t) =>
          (t.reference === reference || t.reference === legacyReference) &&
          t.reason === "purchase",
      );
      if (existing) {
        const current = await storage.getUser(me.id);
        return res.json({
          user: sanitizeUserForResponse(current ?? me),
          credits_added: 0,
          already_processed: true,
          package: verify.package,
        });
      }
      // Live providers: webhook is authoritative. Do NOT grant here —
      // tell the client the purchase is pending and to poll.
      if (verify.provider !== "preview") {
        const current = await storage.getUser(me.id);
        return res.json({
          user: sanitizeUserForResponse(current ?? me),
          credits_added: 0,
          already_processed: false,
          pending: true,
          provider: verify.provider,
          package: verify.package,
        });
      }
      // Preview-only inline grant.
      const updated = await storage.setUserCredits(me.id, me.credits + verify.package.credits);
      await storage.appendCreditTransaction({
        user_id: me.id,
        amount_delta: verify.package.credits,
        balance_after: updated?.credits ?? me.credits + verify.package.credits,
        reason: "purchase",
        reference: legacyReference,
        provider: verify.provider,
        created_at: new Date().toISOString(),
      });
      res.json({
        user: sanitizeUserForResponse(updated),
        credits_added: verify.package.credits,
        already_processed: false,
        package: verify.package,
      });
    } catch (err: any) {
      console.error("payments.completeCheckout failed", err);
      res.status(500).json({ error: "Failed to complete checkout" });
    }
  });

  /* Stripe (and any future live provider) webhook.
   *
   * The signature is computed over the EXACT raw bytes Stripe sent;
   * `req.rawBody` captures that buffer via the express.json verify
   * callback installed in server/index.ts. For belt-and-suspenders
   * safety we also accept a re-stringified body when rawBody is
   * missing (e.g. some middleware re-stacks); that path will fail
   * signature verification cleanly rather than silently passing.
   *
   * Behavior:
   *   - Verify Stripe-Signature; reject with 400 on mismatch.
   *   - Handle only `checkout.session.completed` with payment_status='paid'.
   *   - Fulfill credits exactly once using ledger idempotency on the
   *     reference `stripe:checkout_session:<id>`.
   *   - Ack other events with 200 so Stripe stops retrying.
   */
  app.post("/api/payments/webhook", async (req: Request, res: Response) => {
    if (!paymentProvider.parseWebhookEvent) {
      // Preview / unsupported provider — acknowledge so Stripe (if
      // wired to a preview deployment by mistake) stops retrying, but
      // don't pretend to have processed anything.
      return res.json({ received: true, preview: true });
    }
    const signature = String(req.header("stripe-signature") ?? "");
    if (!signature) {
      return res.status(400).json({ error: "Missing Stripe-Signature header" });
    }
    const rawBody = (req as any).rawBody as Buffer | undefined;
    if (!rawBody || !Buffer.isBuffer(rawBody)) {
      console.error("[payments.webhook] raw body missing \u2014 cannot verify signature");
      return res.status(400).json({ error: "Raw request body unavailable" });
    }
    let parsed;
    try {
      parsed = paymentProvider.parseWebhookEvent(rawBody, signature);
    } catch (err: any) {
      console.warn("[payments.webhook] signature verification failed:", err?.message ?? err);
      return res.status(400).json({ error: "Invalid signature" });
    }
    if (!parsed.fulfillment) {
      // Ack-only path: irrelevant event type, or session not paid.
      console.log(
        `[payments.webhook] ack event=${parsed.event_id} type=${parsed.event_type} (no fulfillment)`,
      );
      return res.json({ received: true, event_id: parsed.event_id, fulfilled: false });
    }
    const f = parsed.fulfillment;
    const reference = `stripe:checkout_session:${f.session_id}`;
    try {
      const user = await storage.getUser(f.user_id);
      if (!user) {
        console.error(
          `[payments.webhook] unknown user_id=${f.user_id} on event=${parsed.event_id}; acking without fulfillment`,
        );
        return res.json({ received: true, event_id: parsed.event_id, fulfilled: false });
      }
      const txs = await storage.listCreditTransactions(user.id);
      const existing = txs.find((t) => t.reference === reference && t.reason === "purchase");
      if (existing) {
        console.log(
          `[payments.webhook] duplicate event=${parsed.event_id} session=${f.session_id} already fulfilled; ack`,
        );
        return res.json({ received: true, event_id: parsed.event_id, fulfilled: false, duplicate: true });
      }
      const updated = await storage.setUserCredits(user.id, user.credits + f.credits);
      try {
        await storage.appendCreditTransaction({
          user_id: user.id,
          amount_delta: f.credits,
          balance_after: updated?.credits ?? user.credits + f.credits,
          reason: "purchase",
          reference,
          provider: "stripe",
          created_at: new Date().toISOString(),
        });
      } catch (err: any) {
        // If a partial unique constraint on (user_id, reference, reason)
        // ever races us (parallel webhook deliveries), roll back the
        // credit grant and ack the duplicate.
        if (err?.code === "23505" || /UNIQUE/i.test(String(err?.message ?? ""))) {
          await storage.setUserCredits(user.id, user.credits);
          console.log(
            `[payments.webhook] duplicate insert raced event=${parsed.event_id}; balance unchanged`,
          );
          return res.json({ received: true, event_id: parsed.event_id, fulfilled: false, duplicate: true });
        }
        throw err;
      }
      console.log(
        `[payments.webhook] fulfilled event=${parsed.event_id} session=${f.session_id} user=${user.id} credits=${f.credits} amount_cents=${f.amount_cents}`,
      );
      res.json({
        received: true,
        event_id: parsed.event_id,
        fulfilled: true,
        credits: f.credits,
      });
    } catch (err: any) {
      console.error("[payments.webhook] fulfillment failed:", err);
      // Return 500 so Stripe retries the delivery.
      res.status(500).json({ error: "Fulfillment failed" });
    }
  });

  /* --------------- Credits: ledger + promo + admin grant --------------- */
  app.get("/api/credits/transactions", async (_req: Request, res: Response) => {
    const meId = getCurrentUserId();
    const me = meId != null ? await storage.getUser(meId) : undefined;
    if (!me) return res.status(401).json({ error: "Not signed in" });
    const txs: CreditTransaction[] = await storage.listCreditTransactions(me.id);
    res.json({ transactions: txs });
  });

  app.post("/api/credits/redeem-code", limitPromo, async (req: Request, res: Response) => {
    const parsed = redeemPromoCodeSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Promo code is required" });
    }
    const meId = getCurrentUserId();
    const me = meId != null ? await storage.getUser(meId) : undefined;
    if (!me) return res.status(401).json({ error: "Not signed in" });

    /* Case-insensitive normalization on the server. The client may
     * also auto-uppercase, but the server is authoritative — a user
     * with lower-case `10free`, mixed `10Free`, or surrounding
     * whitespace lands at the same redemption path. */
    const normalized = parsed.data.code.trim().toUpperCase();
    if (normalized !== FREE_CREDITS_PROMO_CODE) {
      return res.status(400).json({ error: "That promo code isn\u2019t valid." });
    }

    // Unlimited users: don't bother granting credits (they don't need
    // them) and don't record a ledger row — entitlement is independent.
    if (hasUnlimitedCredits(me.email, me.role)) {
      return res.json({
        user: sanitizeUserForResponse(me),
        credits_added: 0,
        unlimited: true,
      });
    }

    // One redemption per user per code, enforced via the ledger.
    if (await storage.hasUserRedeemedPromo(me.id, FREE_CREDITS_PROMO_CODE)) {
      return res.status(409).json({
        error: "This promo code has already been redeemed on your account.",
        reason: "already_redeemed",
      });
    }

    const updated = await storage.setUserCredits(me.id, me.credits + FREE_CREDITS_PROMO_AMOUNT);
    try {
      await storage.appendCreditTransaction({
      user_id: me.id,
      amount_delta: FREE_CREDITS_PROMO_AMOUNT,
      balance_after: updated?.credits ?? me.credits + FREE_CREDITS_PROMO_AMOUNT,
      reason: "promo",
      reference: FREE_CREDITS_PROMO_CODE,
      provider: null,
      created_at: new Date().toISOString(),
      });
    } catch (err: any) {
      // Database-level idempotency guard: if the partial unique index on
      // (user_id, reference) where reason='promo' rejects this insert,
      // roll back the just-applied credit grant and surface the same
      // "already redeemed" error the application-level check returns.
      // Postgres surfaces this as error code 23505 (unique_violation).
      if (err?.code === "23505" || /UNIQUE/i.test(String(err?.message ?? ""))) {
        await storage.setUserCredits(me.id, me.credits);
        return res.status(409).json({
          error: "This promo code has already been redeemed on your account.",
          reason: "already_redeemed",
        });
      }
      throw err;
    }
    res.json({
      user: sanitizeUserForResponse(updated),
      credits_added: FREE_CREDITS_PROMO_AMOUNT,
      unlimited: false,
    });
  });

  /* --------------- Config / health --------------- */
  // Public-safe configuration report. Never echoes secret values —
  // only booleans + structured warnings. Useful as a smoke test after
  // deploy and for an ops dashboard to confirm the running instance
  // is production-safe.
  app.get("/api/config/check", (_req: Request, res: Response) => {
    res.json(getConfigReport());
  });

  return httpServer;
}
