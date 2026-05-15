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
import { generateAnalysis, generateAutofill, prefillFromResumeText, toTitleCase } from "./ai";
import type { Analysis } from "@shared/schema";
import { rateLimit, keyByIp, keyByEmailAndIp } from "./rate-limit";
import { getConfigReport } from "./config";

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
function getActor(): { id: number; role: string; email: string } | null {
  const id = getCurrentUserId();
  if (id == null) return null;
  const u = storage.getUser(id);
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

  /* --------------- Identity / Auth simulation --------------- */
  app.get("/api/me", (_req: Request, res: Response) => {
    const id = getCurrentUserId();
    if (id == null) return res.status(401).json({ error: "Not signed in" });
    const user = storage.getUser(id);
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

  app.post("/api/me/signin", limitSignin, (req: Request, res: Response) => {
    const parsed = signInRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Email and password are required" });
    }
    const email = parsed.data.email.trim().toLowerCase();
    const password = parsed.data.password;
    const user = storage.getUserByEmail(email);
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

  app.post("/api/me/signup", limitSignup, (req: Request, res: Response) => {
    const parsed = signUpRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      // Surface the first validation message so the inline alert is
      // useful even though the client also runs the same schema.
      const first = parsed.error.issues[0];
      return res.status(400).json({ error: first?.message ?? "Invalid input" });
    }
    const full_name = parsed.data.full_name.trim();
    const email = parsed.data.email.trim().toLowerCase();
    if (storage.getUserByEmail(email)) {
      return res.status(409).json({ error: "An account with that email already exists" });
    }
    // New accounts start with zero credits. Entitlement to a free quota
    // (promo codes, unlimited-list, admin role) is granted explicitly
    // elsewhere — never as a side effect of account creation. A zero-credit
    // user can still run analyses, but every report they generate is saved
    // with is_locked=true so the readable body is gated until they buy
    // credits or are otherwise entitled.
    const user = storage.createUser({
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

  app.post("/api/me/forgot-password", limitForgot, (req: Request, res: Response) => {
    const parsed = forgotPasswordRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "A valid email is required" });
    }
    const email = parsed.data.email.trim().toLowerCase();
    const user = storage.getUserByEmail(email);

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
      storage.createPasswordReset({
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
    }
    res.json(genericResponse);
  });

  app.post("/api/me/reset-password", limitReset, (req: Request, res: Response) => {
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

    const user = storage.getUserByEmail(email);
    if (!user) {
      // Run a dummy verify to flatten timing.
      verifyPassword(submittedCode, "scrypt$16384$8$1$00$00");
      return res.status(400).json(INVALID);
    }

    const active = storage.listActivePasswordResetsForUser(user.id);
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
    storage.markPasswordResetUsed(matched.id, usedAt);
    // Invalidate any other still-active codes for the same user so a
    // previously requested code cannot be redeemed after the password
    // has already been reset.
    storage.invalidateOtherPasswordResets(user.id, matched.id, usedAt);

    const updated = storage.setUserPassword(user.id, hashPassword(parsed.data.password));
    if (!updated) return res.status(500).json({ error: "Failed to reset password" });

    setCurrentUserId(updated.id);
    res.json(sanitizeUserForResponse(updated));
  });

  app.post("/api/me/set-password", limitSetPassword, (req: Request, res: Response) => {
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
    const user = storage.getUserByEmail(email);
    if (!user) return res.status(404).json({ error: "No account found for that email" });
    if (user.password_hash) {
      return res
        .status(409)
        .json({ error: "This account already has a password. Sign in to continue." });
    }
    const updated = storage.setUserPassword(user.id, hashPassword(parsed.data.password));
    if (!updated) return res.status(500).json({ error: "Failed to set password" });
    setCurrentUserId(updated.id);
    res.json(sanitizeUserForResponse(updated));
  });

  app.post("/api/me/switch", (req: Request, res: Response) => {
    // Admin-only utility, gated by the current session.
    const meId = getCurrentUserId();
    const me = meId != null ? storage.getUser(meId) : undefined;
    if (!me || me.role !== "admin") return res.status(403).json({ error: "Admin only" });
    const id = Number(req.body?.user_id);
    const user = storage.getUser(id);
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
  app.get("/api/users", (_req: Request, res: Response) => {
    const meId = getCurrentUserId();
    const me = meId != null ? storage.getUser(meId) : undefined;
    if (!me || me.role !== "admin") return res.status(403).json({ error: "Admin only" });
    res.json(storage.listUsers().map(sanitizeUserForResponse));
  });

  app.post("/api/users/set-credits", (req: Request, res: Response) => {
    const meId = getCurrentUserId();
    const me = meId != null ? storage.getUser(meId) : undefined;
    if (!me || me.role !== "admin") return res.status(403).json({ error: "Admin only" });
    const parsed = setCreditsSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
    const target = storage.getUser(parsed.data.user_id);
    if (!target) return res.status(404).json({ error: "User not found" });
    const previous = target.credits;
    const next = parsed.data.credits;
    const updated = storage.setUserCredits(parsed.data.user_id, next);
    if (!updated) return res.status(404).json({ error: "User not found" });
    // Admin balance changes are recorded as a single delta on the
    // ledger so the transaction history is complete. A no-op set
    // (same value) skips the ledger row.
    if (next !== previous) {
      storage.appendCreditTransaction({
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
  app.get("/api/resumes", (_req: Request, res: Response) => {
    const id = getCurrentUserId();
    if (id == null) return res.status(401).json({ error: "Not signed in" });
    res.json(storage.listResumes(id));
  });

  app.post("/api/resumes", (req: Request, res: Response) => {
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

    const resume = storage.createResume({
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

  app.delete("/api/resumes/:id", (req: Request, res: Response) => {
    const actor = getActor();
    if (!actor) return res.status(401).json({ error: "Not signed in" });
    const id = Number(req.params.id);
    const r = storage.getResume(id);
    if (!r) return res.status(404).json({ error: "Not found" });
    if (r.created_by !== actor.id && actor.role !== "admin") {
      return res.status(404).json({ error: "Not found" });
    }
    storage.deleteResume(id);
    res.json({ ok: true });
  });

  app.post("/api/resumes/prefill", (req: Request, res: Response) => {
    const actor = getActor();
    if (!actor) return res.status(401).json({ error: "Not signed in" });
    const parsed = prefillFromResumeSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
    const resume = storage.getResume(parsed.data.resume_id);
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

  /* --------------- Analyses --------------- */
  app.get("/api/analyses", (_req: Request, res: Response) => {
    const id = getCurrentUserId();
    if (id == null) return res.status(401).json({ error: "Not signed in" });
    res.json(storage.listAnalyses(id).map(sanitizeAnalysisForResponse));
  });

  app.get("/api/analyses/:id", (req: Request, res: Response) => {
    const actor = getActor();
    if (!actor) return res.status(401).json({ error: "Not signed in" });
    const id = Number(req.params.id);
    const a = storage.getAnalysis(id);
    // Collapse "not found" and "not yours" into the same 404 so an
    // attacker cannot enumerate analysis ids belonging to other users.
    if (!a) return res.status(404).json({ error: "Not found" });
    if (a.created_by !== actor.id && actor.role !== "admin") {
      return res.status(404).json({ error: "Not found" });
    }
    res.json(sanitizeAnalysisForResponse(a));
  });

  app.delete("/api/analyses/:id", (req: Request, res: Response) => {
    const actor = getActor();
    if (!actor) return res.status(401).json({ error: "Not signed in" });
    const id = Number(req.params.id);
    const a = storage.getAnalysis(id);
    if (!a) return res.status(404).json({ error: "Not found" });
    if (a.created_by !== actor.id && actor.role !== "admin") {
      return res.status(404).json({ error: "Not found" });
    }
    storage.deleteAnalysis(id);
    res.json({ ok: true });
  });

  /* Unlock a previously locked analysis by consuming exactly one credit.
   * Unlimited accounts (admin or entitled email) unlock for free and
   * do NOT generate a ledger row — entitlement is a separate concept
   * from the credit balance.
   *
   * Paying users with zero credits get a 402 with a clear, actionable
   * error so the frontend can route them to the Buy Credits flow. */
  app.post("/api/analyses/:id/unlock", limitUnlock, (req: Request, res: Response) => {
    const id = Number(req.params.id);
    const meId = getCurrentUserId();
    const me = meId != null ? storage.getUser(meId) : undefined;
    if (!me) return res.status(401).json({ error: "Not signed in" });
    const analysis = storage.getAnalysis(id);
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
      const updated = storage.decrementCredits(me.id);
      // Ledger row for the spend — always exactly -1.
      storage.appendCreditTransaction({
        user_id: me.id,
        amount_delta: -1,
        balance_after: updated?.credits ?? Math.max(0, me.credits - 1),
        reason: "unlock_spend",
        reference: `analysis:${id}`,
        provider: null,
        created_at: new Date().toISOString(),
      });
    }
    const unlocked = storage.unlockAnalysis(id);
    res.json(unlocked);
  });

  app.post("/api/analyses", async (req: Request, res: Response) => {
    const parsed = analyzeRequestSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
    const meId = getCurrentUserId();
    const me = meId != null ? storage.getUser(meId) : undefined;
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
      const r = storage.getResume(parsed.data.resume_id);
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
      if (!unlimited && !willLock) storage.decrementCredits(me.id);

      const saved = storage.createAnalysis({
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
    const me = meId != null ? storage.getUser(meId) : undefined;
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
     * provider redirects the buyer back. The handler:
     *   1. Verifies the session with the provider (signature for live,
     *      HMAC for preview).
     *   2. Looks up the package and grants credits ONCE via the ledger.
     *      Duplicate completion calls (e.g. user refreshes the page)
     *      are idempotent: the ledger row is keyed by `session_id` in
     *      the reference column, and a row already present short-
     *      circuits the grant.
     */
    const meId = getCurrentUserId();
    const me = meId != null ? storage.getUser(meId) : undefined;
    if (!me) return res.status(401).json({ error: "Not signed in" });

    const session_id = String(req.body?.session_id ?? "");
    const token = String(req.body?.token ?? "");
    if (!session_id) return res.status(400).json({ error: "Missing session id" });

    try {
      const verify = await paymentProvider.verifySession({ session_id, token });
      if (!verify.ok || !verify.package) {
        return res.status(400).json({ error: verify.error ?? "Could not verify the purchase" });
      }
      const reference = `${verify.provider}:${session_id}`;
      // Idempotency — if this session already produced a ledger row,
      // return the current user without granting again.
      const existing = storage
        .listCreditTransactions(me.id)
        .find((t) => t.reference === reference && t.reason === "purchase");
      if (existing) {
        const current = storage.getUser(me.id);
        return res.json({
          user: sanitizeUserForResponse(current ?? me),
          credits_added: 0,
          already_processed: true,
          package: verify.package,
        });
      }
      const updated = storage.setUserCredits(me.id, me.credits + verify.package.credits);
      storage.appendCreditTransaction({
        user_id: me.id,
        amount_delta: verify.package.credits,
        balance_after: updated?.credits ?? me.credits + verify.package.credits,
        reason: "purchase",
        reference,
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

  app.post("/api/payments/webhook", (_req: Request, res: Response) => {
    // === BOUNDARY: real webhook ===
    // Production (Stripe / Lemon Squeezy / Paddle): verify signature
    // header, parse the event, and on `checkout.session.completed` (or
    // equivalent) append a ledger row + setUserCredits exactly as
    // /api/payments/complete-checkout does above. Webhook is the
    // authoritative grant in production (the redirect handler becomes
    // a UX nicety that retries if the webhook is delayed).
    res.json({ received: true, preview: true });
  });

  /* --------------- Credits: ledger + promo + admin grant --------------- */
  app.get("/api/credits/transactions", (_req: Request, res: Response) => {
    const meId = getCurrentUserId();
    const me = meId != null ? storage.getUser(meId) : undefined;
    if (!me) return res.status(401).json({ error: "Not signed in" });
    const txs: CreditTransaction[] = storage.listCreditTransactions(me.id);
    res.json({ transactions: txs });
  });

  app.post("/api/credits/redeem-code", limitPromo, (req: Request, res: Response) => {
    const parsed = redeemPromoCodeSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Promo code is required" });
    }
    const meId = getCurrentUserId();
    const me = meId != null ? storage.getUser(meId) : undefined;
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
    if (storage.hasUserRedeemedPromo(me.id, FREE_CREDITS_PROMO_CODE)) {
      return res.status(409).json({
        error: "This promo code has already been redeemed on your account.",
        reason: "already_redeemed",
      });
    }

    const updated = storage.setUserCredits(me.id, me.credits + FREE_CREDITS_PROMO_AMOUNT);
    storage.appendCreditTransaction({
      user_id: me.id,
      amount_delta: FREE_CREDITS_PROMO_AMOUNT,
      balance_after: updated?.credits ?? me.credits + FREE_CREDITS_PROMO_AMOUNT,
      reason: "promo",
      reference: FREE_CREDITS_PROMO_CODE,
      provider: null,
      created_at: new Date().toISOString(),
    });
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
