/* =====================================================================
 * Storage layer
 *
 * Provides an async storage interface (`IStorage`) backed by either
 * SQLite (default — used in dev/preview without DATABASE_URL) or
 * Postgres (selected when DATABASE_URL starts with postgres:// or
 * postgresql://). All methods return Promises so the route handlers
 * can use a single uniform `await` pattern regardless of backend.
 *
 * The SQLite implementation uses better-sqlite3 (synchronous, wrapped
 * in Promise.resolve()). The Postgres implementation uses node-postgres
 * (`pg`) directly with parameterized SQL — no Drizzle on the Postgres
 * side, because Drizzle's better-sqlite3 driver is sync and its
 * node-postgres driver is async, and we want a single implementation
 * shape with explicit, auditable SQL.
 *
 * `initStorage()` MUST be awaited at startup (server/index.ts) before
 * any route handler runs. It picks the backend, runs CREATE TABLE IF
 * NOT EXISTS migrations, and bootstraps the seeded preview accounts.
 * ===================================================================== */
import {
  type User,
  type InsertUser,
  type Resume,
  type InsertResume,
  type Analysis,
  type InsertAnalysis,
  type PasswordReset,
  type CreditTransaction,
  type InsertCreditTransaction,
  type FunnelEvent,
  type InsertFunnelEvent,
  type ReferralCode,
  type PreviewFollowUp,
  type InsertPreviewFollowUp,
} from "@shared/schema";
import Database from "better-sqlite3";
import { Pool, type PoolClient } from "pg";
import { hashPassword } from "./password";

/* ---------------------------------------------------------------------
 * Storage interface — all methods are async so the same surface works
 * for both sync SQLite and async Postgres backends.
 * ------------------------------------------------------------------- */
export interface IStorage {
  // Users
  getUser(id: number): Promise<User | undefined>;
  getUserByEmail(email: string): Promise<User | undefined>;
  createUser(user: InsertUser): Promise<User>;
  listUsers(): Promise<User[]>;
  setUserCredits(id: number, credits: number): Promise<User | undefined>;
  decrementCredits(id: number): Promise<User | undefined>;
  setUserPassword(id: number, password_hash: string): Promise<User | undefined>;
  // Password reset codes
  createPasswordReset(input: {
    user_id: number;
    code_hash: string;
    created_at: string;
    expires_at: string;
  }): Promise<PasswordReset>;
  listActivePasswordResetsForUser(user_id: number): Promise<PasswordReset[]>;
  markPasswordResetUsed(id: number, used_at: string): Promise<void>;
  invalidateOtherPasswordResets(
    user_id: number,
    except_id: number,
    used_at: string,
  ): Promise<void>;
  // Credit ledger
  appendCreditTransaction(tx: InsertCreditTransaction): Promise<CreditTransaction>;
  listCreditTransactions(user_id: number): Promise<CreditTransaction[]>;
  hasUserRedeemedPromo(user_id: number, promo_code_reference: string): Promise<boolean>;
  /** True when the user has already consumed their one free full report.
   * Backed by the presence of a credit_transactions row with
   * reason='free_report_claim'. See shared/entitlements.ts. */
  hasUsedFreeReport(user_id: number): Promise<boolean>;
  /** Count of accounts that have claimed their free first full report.
   * Used by the admin dashboard's free-first funnel metrics. */
  countFreeReportClaims(opts?: { since?: string; until?: string }): Promise<number>;
  /** Count purchase rows whose `reference` includes the given substring.
   * Used to count launch-promo redemptions across all users — the
   * promo reference suffix (`:promo=<name>`) is appended at fulfillment
   * time so a single LIKE query can answer "how many promo unlocks?". */
  countPurchasesByReferenceSubstring(substring: string): Promise<number>;
  // Resumes
  listResumes(userId: number): Promise<Resume[]>;
  getResume(id: number): Promise<Resume | undefined>;
  createResume(resume: InsertResume): Promise<Resume>;
  deleteResume(id: number): Promise<{ changes: number }>;
  // Analyses
  listAnalyses(userId: number): Promise<Analysis[]>;
  getAnalysis(id: number): Promise<Analysis | undefined>;
  createAnalysis(analysis: InsertAnalysis): Promise<Analysis>;
  deleteAnalysis(id: number): Promise<{ changes: number }>;
  unlockAnalysis(id: number): Promise<Analysis | undefined>;
  // Funnel events
  appendFunnelEvent(ev: InsertFunnelEvent): Promise<FunnelEvent>;
  countFunnelEvents(opts: {
    name?: string;
    since?: string;
    until?: string;
    variant?: string;
    referral_code?: string;
  }): Promise<number>;
  /** Returns rows grouped by event name within an optional date range. */
  aggregateFunnelEvents(opts: { since?: string; until?: string }): Promise<
    Array<{ name: string; count: number }>
  >;
  /** Returns counts grouped by variant for a single event name. */
  aggregateFunnelEventsByVariant(opts: {
    name: string;
    since?: string;
    until?: string;
  }): Promise<Array<{ variant: string | null; count: number }>>;
  // Referrals
  getReferralCodeForUser(user_id: number): Promise<ReferralCode | undefined>;
  getReferralCodeByCode(code: string): Promise<ReferralCode | undefined>;
  createReferralCode(input: { user_id: number; code: string; created_at: string }): Promise<ReferralCode>;
  // Preview follow-ups
  getPreviewFollowUp(user_id: number, kind: string): Promise<PreviewFollowUp | undefined>;
  createPreviewFollowUp(row: InsertPreviewFollowUp): Promise<PreviewFollowUp>;
  updatePreviewFollowUp(
    id: number,
    patch: Partial<Pick<PreviewFollowUp, "status" | "sent_at" | "reason">>,
  ): Promise<void>;
  listPendingPreviewFollowUps(now: string): Promise<PreviewFollowUp[]>;
}

/* =====================================================================
 * SQLite implementation (better-sqlite3, synchronous under the hood,
 * awaited via Promise.resolve()). Used for local/preview when
 * DATABASE_URL is absent or does not point at a Postgres database.
 * ===================================================================== */
class SqliteStorage implements IStorage {
  private sqlite: Database.Database;

  constructor(path = "data.db") {
    this.sqlite = new Database(path);
    this.sqlite.pragma("journal_mode = WAL");
    this.migrate();
  }

  private migrate() {
    this.sqlite.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  full_name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL DEFAULT 'user',
  credits INTEGER NOT NULL DEFAULT 0,
  created_date TEXT NOT NULL,
  password_hash TEXT
);
CREATE TABLE IF NOT EXISTS resumes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_date TEXT NOT NULL,
  created_by INTEGER NOT NULL,
  filename TEXT NOT NULL,
  content_type TEXT NOT NULL,
  file_url TEXT NOT NULL,
  extracted_text TEXT NOT NULL,
  size_bytes INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS analyses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_date TEXT NOT NULL,
  created_by INTEGER NOT NULL,
  job_title TEXT NOT NULL,
  job_description TEXT NOT NULL,
  technology_context TEXT,
  resume_id INTEGER,
  result_text TEXT NOT NULL,
  provider_used TEXT NOT NULL,
  automation_risk TEXT NOT NULL,
  risk_score INTEGER NOT NULL,
  is_locked INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS password_resets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  code_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_password_resets_user ON password_resets(user_id);
CREATE TABLE IF NOT EXISTS credit_transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  amount_delta INTEGER NOT NULL,
  balance_after INTEGER NOT NULL,
  reason TEXT NOT NULL,
  reference TEXT,
  provider TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_credit_transactions_user ON credit_transactions(user_id);
CREATE INDEX IF NOT EXISTS idx_credit_transactions_user_reason ON credit_transactions(user_id, reason);
CREATE TABLE IF NOT EXISTS funnel_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  anon_id TEXT,
  user_id INTEGER,
  props TEXT,
  variant TEXT,
  referral_code TEXT
);
CREATE INDEX IF NOT EXISTS idx_funnel_events_name_time ON funnel_events(name, created_at);
CREATE INDEX IF NOT EXISTS idx_funnel_events_time ON funnel_events(created_at);
CREATE INDEX IF NOT EXISTS idx_funnel_events_ref ON funnel_events(referral_code);
CREATE TABLE IF NOT EXISTS referral_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL UNIQUE,
  code TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_referral_codes_code ON referral_codes(code);
CREATE TABLE IF NOT EXISTS preview_follow_ups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  analysis_id INTEGER,
  kind TEXT NOT NULL,
  scheduled_for TEXT,
  sent_at TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  reason TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_preview_follow_ups_user_kind ON preview_follow_ups(user_id, kind);
CREATE INDEX IF NOT EXISTS idx_preview_follow_ups_status ON preview_follow_ups(status);
`);
    // Additive migrations for legacy databases.
    try {
      const cols = this.sqlite
        .prepare("PRAGMA table_info(analyses)")
        .all() as Array<{ name: string }>;
      if (!cols.some((c) => c.name === "is_locked")) {
        this.sqlite.exec(
          "ALTER TABLE analyses ADD COLUMN is_locked INTEGER NOT NULL DEFAULT 0",
        );
      }
    } catch {
      // safe to ignore — table was just created
    }
    try {
      const cols = this.sqlite
        .prepare("PRAGMA table_info(users)")
        .all() as Array<{ name: string }>;
      if (!cols.some((c) => c.name === "password_hash")) {
        this.sqlite.exec("ALTER TABLE users ADD COLUMN password_hash TEXT");
      }
    } catch {
      // safe to ignore
    }
  }

  // Normalize the boolean-ish SQLite integer columns to true JS booleans
  // so the type contract matches what shared/schema.ts promises.
  private hydrateAnalysis(row: any): Analysis {
    if (!row) return row;
    return { ...row, is_locked: !!row.is_locked } as Analysis;
  }

  async getUser(id: number): Promise<User | undefined> {
    return this.sqlite
      .prepare("SELECT * FROM users WHERE id = ?")
      .get(id) as User | undefined;
  }
  async getUserByEmail(email: string): Promise<User | undefined> {
    return this.sqlite
      .prepare("SELECT * FROM users WHERE email = ?")
      .get(email) as User | undefined;
  }
  async createUser(u: InsertUser): Promise<User> {
    const row = this.sqlite
      .prepare(
        `INSERT INTO users (full_name, email, role, credits, created_date, password_hash)
         VALUES (?, ?, ?, ?, ?, ?) RETURNING *`,
      )
      .get(
        u.full_name,
        u.email,
        u.role ?? "user",
        u.credits ?? 0,
        u.created_date,
        u.password_hash ?? null,
      ) as User;
    return row;
  }
  async listUsers(): Promise<User[]> {
    return this.sqlite.prepare("SELECT * FROM users ORDER BY id").all() as User[];
  }
  async setUserCredits(id: number, credits: number): Promise<User | undefined> {
    return this.sqlite
      .prepare("UPDATE users SET credits = ? WHERE id = ? RETURNING *")
      .get(credits, id) as User | undefined;
  }
  async decrementCredits(id: number): Promise<User | undefined> {
    return this.sqlite
      .prepare("UPDATE users SET credits = credits - 1 WHERE id = ? RETURNING *")
      .get(id) as User | undefined;
  }
  async setUserPassword(id: number, password_hash: string): Promise<User | undefined> {
    return this.sqlite
      .prepare("UPDATE users SET password_hash = ? WHERE id = ? RETURNING *")
      .get(password_hash, id) as User | undefined;
  }

  async createPasswordReset(input: {
    user_id: number;
    code_hash: string;
    created_at: string;
    expires_at: string;
  }): Promise<PasswordReset> {
    return this.sqlite
      .prepare(
        `INSERT INTO password_resets (user_id, code_hash, created_at, expires_at, used_at)
         VALUES (?, ?, ?, ?, NULL) RETURNING *`,
      )
      .get(
        input.user_id,
        input.code_hash,
        input.created_at,
        input.expires_at,
      ) as PasswordReset;
  }
  async listActivePasswordResetsForUser(user_id: number): Promise<PasswordReset[]> {
    return this.sqlite
      .prepare(
        `SELECT * FROM password_resets
          WHERE user_id = ? AND used_at IS NULL
          ORDER BY id DESC`,
      )
      .all(user_id) as PasswordReset[];
  }
  async markPasswordResetUsed(id: number, used_at: string): Promise<void> {
    this.sqlite
      .prepare("UPDATE password_resets SET used_at = ? WHERE id = ?")
      .run(used_at, id);
  }
  async invalidateOtherPasswordResets(
    user_id: number,
    except_id: number,
    used_at: string,
  ): Promise<void> {
    this.sqlite
      .prepare(
        `UPDATE password_resets SET used_at = ?
          WHERE user_id = ? AND used_at IS NULL AND id != ?`,
      )
      .run(used_at, user_id, except_id);
  }

  async appendCreditTransaction(tx: InsertCreditTransaction): Promise<CreditTransaction> {
    return this.sqlite
      .prepare(
        `INSERT INTO credit_transactions
           (user_id, amount_delta, balance_after, reason, reference, provider, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *`,
      )
      .get(
        tx.user_id,
        tx.amount_delta,
        tx.balance_after,
        tx.reason,
        tx.reference ?? null,
        tx.provider ?? null,
        tx.created_at,
      ) as CreditTransaction;
  }
  async listCreditTransactions(user_id: number): Promise<CreditTransaction[]> {
    return this.sqlite
      .prepare(
        `SELECT * FROM credit_transactions WHERE user_id = ? ORDER BY id DESC`,
      )
      .all(user_id) as CreditTransaction[];
  }
  async hasUserRedeemedPromo(user_id: number, promo: string): Promise<boolean> {
    const hit = this.sqlite
      .prepare(
        `SELECT 1 FROM credit_transactions
          WHERE user_id = ? AND reason = 'promo' AND reference = ?
          LIMIT 1`,
      )
      .get(user_id, promo);
    return !!hit;
  }
  async hasUsedFreeReport(user_id: number): Promise<boolean> {
    const hit = this.sqlite
      .prepare(
        `SELECT 1 FROM credit_transactions
          WHERE user_id = ? AND reason = 'free_report_claim'
          LIMIT 1`,
      )
      .get(user_id);
    return !!hit;
  }
  async countFreeReportClaims(opts?: { since?: string; until?: string }): Promise<number> {
    const conds: string[] = ["reason = 'free_report_claim'"];
    const params: any[] = [];
    if (opts?.since) { conds.push("created_at >= ?"); params.push(opts.since); }
    if (opts?.until) { conds.push("created_at <= ?"); params.push(opts.until); }
    const row = this.sqlite
      .prepare(`SELECT COUNT(*) AS n FROM credit_transactions WHERE ${conds.join(" AND ")}`)
      .get(...params) as { n: number } | undefined;
    return Number(row?.n ?? 0);
  }
  async countPurchasesByReferenceSubstring(substring: string): Promise<number> {
    if (!substring) return 0;
    const row = this.sqlite
      .prepare(
        `SELECT COUNT(*) AS n FROM credit_transactions
          WHERE reason = 'purchase' AND reference LIKE ?`,
      )
      .get(`%${substring}%`) as { n: number } | undefined;
    return Number(row?.n ?? 0);
  }

  async listResumes(userId: number): Promise<Resume[]> {
    return this.sqlite
      .prepare("SELECT * FROM resumes WHERE created_by = ? ORDER BY id DESC")
      .all(userId) as Resume[];
  }
  async getResume(id: number): Promise<Resume | undefined> {
    return this.sqlite
      .prepare("SELECT * FROM resumes WHERE id = ?")
      .get(id) as Resume | undefined;
  }
  async createResume(r: InsertResume): Promise<Resume> {
    return this.sqlite
      .prepare(
        `INSERT INTO resumes
           (created_date, created_by, filename, content_type, file_url, extracted_text, size_bytes)
         VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *`,
      )
      .get(
        r.created_date,
        r.created_by,
        r.filename,
        r.content_type,
        r.file_url,
        r.extracted_text,
        r.size_bytes,
      ) as Resume;
  }
  async deleteResume(id: number): Promise<{ changes: number }> {
    const r = this.sqlite.prepare("DELETE FROM resumes WHERE id = ?").run(id);
    return { changes: r.changes };
  }

  async listAnalyses(userId: number): Promise<Analysis[]> {
    const rows = this.sqlite
      .prepare("SELECT * FROM analyses WHERE created_by = ? ORDER BY id DESC")
      .all(userId) as any[];
    return rows.map((r) => this.hydrateAnalysis(r));
  }
  async getAnalysis(id: number): Promise<Analysis | undefined> {
    const row = this.sqlite
      .prepare("SELECT * FROM analyses WHERE id = ?")
      .get(id);
    return row ? this.hydrateAnalysis(row) : undefined;
  }
  async createAnalysis(a: InsertAnalysis): Promise<Analysis> {
    const row = this.sqlite
      .prepare(
        `INSERT INTO analyses
           (created_date, created_by, job_title, job_description, technology_context,
            resume_id, result_text, provider_used, automation_risk, risk_score, is_locked)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
      )
      .get(
        a.created_date,
        a.created_by,
        a.job_title,
        a.job_description,
        a.technology_context ?? null,
        a.resume_id ?? null,
        a.result_text,
        a.provider_used,
        a.automation_risk,
        a.risk_score,
        a.is_locked ? 1 : 0,
      );
    return this.hydrateAnalysis(row);
  }
  async deleteAnalysis(id: number): Promise<{ changes: number }> {
    const r = this.sqlite.prepare("DELETE FROM analyses WHERE id = ?").run(id);
    return { changes: r.changes };
  }
  async unlockAnalysis(id: number): Promise<Analysis | undefined> {
    const row = this.sqlite
      .prepare("UPDATE analyses SET is_locked = 0 WHERE id = ? RETURNING *")
      .get(id);
    return row ? this.hydrateAnalysis(row) : undefined;
  }

  async appendFunnelEvent(ev: InsertFunnelEvent): Promise<FunnelEvent> {
    return this.sqlite
      .prepare(
        `INSERT INTO funnel_events (name, created_at, anon_id, user_id, props, variant, referral_code)
         VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *`,
      )
      .get(
        ev.name,
        ev.created_at,
        ev.anon_id ?? null,
        ev.user_id ?? null,
        ev.props ?? null,
        ev.variant ?? null,
        ev.referral_code ?? null,
      ) as FunnelEvent;
  }
  async countFunnelEvents(opts: {
    name?: string;
    since?: string;
    until?: string;
    variant?: string;
    referral_code?: string;
  }): Promise<number> {
    const conds: string[] = [];
    const params: any[] = [];
    if (opts.name) { conds.push("name = ?"); params.push(opts.name); }
    if (opts.since) { conds.push("created_at >= ?"); params.push(opts.since); }
    if (opts.until) { conds.push("created_at <= ?"); params.push(opts.until); }
    if (opts.variant) { conds.push("variant = ?"); params.push(opts.variant); }
    if (opts.referral_code) { conds.push("referral_code = ?"); params.push(opts.referral_code); }
    const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
    const row = this.sqlite
      .prepare(`SELECT COUNT(*) AS n FROM funnel_events ${where}`)
      .get(...params) as { n: number } | undefined;
    return Number(row?.n ?? 0);
  }
  async aggregateFunnelEvents(opts: { since?: string; until?: string }): Promise<
    Array<{ name: string; count: number }>
  > {
    const conds: string[] = [];
    const params: any[] = [];
    if (opts.since) { conds.push("created_at >= ?"); params.push(opts.since); }
    if (opts.until) { conds.push("created_at <= ?"); params.push(opts.until); }
    const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
    const rows = this.sqlite
      .prepare(
        `SELECT name, COUNT(*) AS count FROM funnel_events ${where}
         GROUP BY name ORDER BY count DESC`,
      )
      .all(...params) as Array<{ name: string; count: number }>;
    return rows.map((r) => ({ name: r.name, count: Number(r.count) }));
  }
  async aggregateFunnelEventsByVariant(opts: { name: string; since?: string; until?: string }) {
    const conds: string[] = ["name = ?"];
    const params: any[] = [opts.name];
    if (opts.since) { conds.push("created_at >= ?"); params.push(opts.since); }
    if (opts.until) { conds.push("created_at <= ?"); params.push(opts.until); }
    const rows = this.sqlite
      .prepare(
        `SELECT variant, COUNT(*) AS count FROM funnel_events
          WHERE ${conds.join(" AND ")}
          GROUP BY variant ORDER BY count DESC`,
      )
      .all(...params) as Array<{ variant: string | null; count: number }>;
    return rows.map((r) => ({ variant: r.variant ?? null, count: Number(r.count) }));
  }

  async getReferralCodeForUser(user_id: number): Promise<ReferralCode | undefined> {
    return this.sqlite
      .prepare("SELECT * FROM referral_codes WHERE user_id = ?")
      .get(user_id) as ReferralCode | undefined;
  }
  async getReferralCodeByCode(code: string): Promise<ReferralCode | undefined> {
    return this.sqlite
      .prepare("SELECT * FROM referral_codes WHERE code = ?")
      .get(code) as ReferralCode | undefined;
  }
  async createReferralCode(input: {
    user_id: number;
    code: string;
    created_at: string;
  }): Promise<ReferralCode> {
    return this.sqlite
      .prepare(
        `INSERT INTO referral_codes (user_id, code, created_at)
         VALUES (?, ?, ?) RETURNING *`,
      )
      .get(input.user_id, input.code, input.created_at) as ReferralCode;
  }

  async getPreviewFollowUp(user_id: number, kind: string): Promise<PreviewFollowUp | undefined> {
    return this.sqlite
      .prepare("SELECT * FROM preview_follow_ups WHERE user_id = ? AND kind = ?")
      .get(user_id, kind) as PreviewFollowUp | undefined;
  }
  async createPreviewFollowUp(row: InsertPreviewFollowUp): Promise<PreviewFollowUp> {
    return this.sqlite
      .prepare(
        `INSERT INTO preview_follow_ups
            (user_id, analysis_id, kind, scheduled_for, sent_at, status, reason)
          VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *`,
      )
      .get(
        row.user_id,
        row.analysis_id ?? null,
        row.kind,
        row.scheduled_for ?? null,
        row.sent_at ?? null,
        row.status,
        row.reason ?? null,
      ) as PreviewFollowUp;
  }
  async updatePreviewFollowUp(
    id: number,
    patch: Partial<Pick<PreviewFollowUp, "status" | "sent_at" | "reason">>,
  ): Promise<void> {
    const fields: string[] = [];
    const params: any[] = [];
    if (patch.status !== undefined) { fields.push("status = ?"); params.push(patch.status); }
    if (patch.sent_at !== undefined) { fields.push("sent_at = ?"); params.push(patch.sent_at); }
    if (patch.reason !== undefined) { fields.push("reason = ?"); params.push(patch.reason); }
    if (!fields.length) return;
    params.push(id);
    this.sqlite
      .prepare(`UPDATE preview_follow_ups SET ${fields.join(", ")} WHERE id = ?`)
      .run(...params);
  }
  async listPendingPreviewFollowUps(now: string): Promise<PreviewFollowUp[]> {
    return this.sqlite
      .prepare(
        `SELECT * FROM preview_follow_ups
          WHERE status = 'pending'
            AND (scheduled_for IS NULL OR scheduled_for <= ?)
          ORDER BY id ASC LIMIT 50`,
      )
      .all(now) as PreviewFollowUp[];
  }
}

/* =====================================================================
 * Postgres implementation (node-postgres `pg`). Selected when
 * DATABASE_URL starts with postgres:// or postgresql://.
 *
 * Schema notes:
 *   - SERIAL primary keys mirror SQLite's AUTOINCREMENT.
 *   - is_locked is a real BOOLEAN.
 *   - All date/time columns stay as TEXT so the wire format and the
 *     application code (ISO strings) match the SQLite layout byte for
 *     byte. The application is the single owner of timestamp parsing,
 *     so we don't lean on Postgres TIMESTAMP semantics.
 *   - Email uniqueness is enforced.
 *   - Idempotency for promo redemption is enforced at the application
 *     layer (hasUserRedeemedPromo) AND at the database layer via a
 *     partial unique index on (user_id, reference) where reason='promo'.
 * ===================================================================== */
class PostgresStorage implements IStorage {
  private pool: Pool;
  private migrated = false;

  constructor(connectionString: string) {
    // Render Postgres requires SSL. The "external" connection strings
    // they hand out include sslmode=require already, but we add a
    // permissive fallback for managed Postgres providers that supply
    // self-signed certs (Render, Heroku, Supabase pooler, etc.).
    const useSsl =
      process.env.DATABASE_SSL === "1" ||
      /sslmode=require/i.test(connectionString) ||
      /\.render\.com/i.test(connectionString) ||
      /\.amazonaws\.com/i.test(connectionString) ||
      /supabase\./i.test(connectionString);
    this.pool = new Pool({
      connectionString,
      ssl: useSsl ? { rejectUnauthorized: false } : undefined,
      max: Number(process.env.DATABASE_POOL_MAX ?? 10),
    });
  }

  async migrate(): Promise<void> {
    if (this.migrated) return;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`
        CREATE TABLE IF NOT EXISTS users (
          id SERIAL PRIMARY KEY,
          full_name TEXT NOT NULL,
          email TEXT NOT NULL UNIQUE,
          role TEXT NOT NULL DEFAULT 'user',
          credits INTEGER NOT NULL DEFAULT 0,
          created_date TEXT NOT NULL,
          password_hash TEXT
        );
      `);
      await client.query(`
        CREATE TABLE IF NOT EXISTS resumes (
          id SERIAL PRIMARY KEY,
          created_date TEXT NOT NULL,
          created_by INTEGER NOT NULL,
          filename TEXT NOT NULL,
          content_type TEXT NOT NULL,
          file_url TEXT NOT NULL,
          extracted_text TEXT NOT NULL,
          size_bytes INTEGER NOT NULL
        );
      `);
      await client.query(`
        CREATE TABLE IF NOT EXISTS analyses (
          id SERIAL PRIMARY KEY,
          created_date TEXT NOT NULL,
          created_by INTEGER NOT NULL,
          job_title TEXT NOT NULL,
          job_description TEXT NOT NULL,
          technology_context TEXT,
          resume_id INTEGER,
          result_text TEXT NOT NULL,
          provider_used TEXT NOT NULL,
          automation_risk TEXT NOT NULL,
          risk_score INTEGER NOT NULL,
          is_locked BOOLEAN NOT NULL DEFAULT FALSE
        );
      `);
      await client.query(`
        CREATE TABLE IF NOT EXISTS password_resets (
          id SERIAL PRIMARY KEY,
          user_id INTEGER NOT NULL,
          code_hash TEXT NOT NULL,
          created_at TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          used_at TEXT
        );
      `);
      await client.query(
        `CREATE INDEX IF NOT EXISTS idx_password_resets_user ON password_resets(user_id);`,
      );
      await client.query(`
        CREATE TABLE IF NOT EXISTS credit_transactions (
          id SERIAL PRIMARY KEY,
          user_id INTEGER NOT NULL,
          amount_delta INTEGER NOT NULL,
          balance_after INTEGER NOT NULL,
          reason TEXT NOT NULL,
          reference TEXT,
          provider TEXT,
          created_at TEXT NOT NULL
        );
      `);
      await client.query(
        `CREATE INDEX IF NOT EXISTS idx_credit_transactions_user
           ON credit_transactions(user_id);`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS idx_credit_transactions_user_reason
           ON credit_transactions(user_id, reason);`,
      );
      // Idempotency guard: a given (user_id, reference) pair under
      // reason='promo' may only appear once. This is the database-level
      // partner to hasUserRedeemedPromo() — even a race condition that
      // sneaks past the application check cannot double-credit.
      await client.query(
        `CREATE UNIQUE INDEX IF NOT EXISTS uq_credit_transactions_promo_once
           ON credit_transactions(user_id, reference)
         WHERE reason = 'promo' AND reference IS NOT NULL;`,
      );
      await client.query(`
        CREATE TABLE IF NOT EXISTS funnel_events (
          id SERIAL PRIMARY KEY,
          name TEXT NOT NULL,
          created_at TEXT NOT NULL,
          anon_id TEXT,
          user_id INTEGER,
          props TEXT,
          variant TEXT,
          referral_code TEXT
        );
      `);
      await client.query(
        `CREATE INDEX IF NOT EXISTS idx_funnel_events_name_time
           ON funnel_events(name, created_at);`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS idx_funnel_events_time
           ON funnel_events(created_at);`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS idx_funnel_events_ref
           ON funnel_events(referral_code);`,
      );
      await client.query(`
        CREATE TABLE IF NOT EXISTS referral_codes (
          id SERIAL PRIMARY KEY,
          user_id INTEGER NOT NULL UNIQUE,
          code TEXT NOT NULL UNIQUE,
          created_at TEXT NOT NULL
        );
      `);
      await client.query(
        `CREATE INDEX IF NOT EXISTS idx_referral_codes_code
           ON referral_codes(code);`,
      );
      await client.query(`
        CREATE TABLE IF NOT EXISTS preview_follow_ups (
          id SERIAL PRIMARY KEY,
          user_id INTEGER NOT NULL,
          analysis_id INTEGER,
          kind TEXT NOT NULL,
          scheduled_for TEXT,
          sent_at TEXT,
          status TEXT NOT NULL DEFAULT 'pending',
          reason TEXT
        );
      `);
      await client.query(
        `CREATE UNIQUE INDEX IF NOT EXISTS uq_preview_follow_ups_user_kind
           ON preview_follow_ups(user_id, kind);`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS idx_preview_follow_ups_status
           ON preview_follow_ups(status);`,
      );
      await client.query("COMMIT");
      this.migrated = true;
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  // Postgres returns booleans natively; no hydration needed beyond
  // shaping the result to the shared types.
  private rowToUser(r: any): User | undefined {
    return r ? (r as User) : undefined;
  }
  private rowToAnalysis(r: any): Analysis | undefined {
    if (!r) return undefined;
    return { ...r, is_locked: !!r.is_locked } as Analysis;
  }

  async getUser(id: number): Promise<User | undefined> {
    const r = await this.pool.query("SELECT * FROM users WHERE id = $1", [id]);
    return this.rowToUser(r.rows[0]);
  }
  async getUserByEmail(email: string): Promise<User | undefined> {
    const r = await this.pool.query("SELECT * FROM users WHERE email = $1", [email]);
    return this.rowToUser(r.rows[0]);
  }
  async createUser(u: InsertUser): Promise<User> {
    const r = await this.pool.query(
      `INSERT INTO users (full_name, email, role, credits, created_date, password_hash)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [
        u.full_name,
        u.email,
        u.role ?? "user",
        u.credits ?? 0,
        u.created_date,
        u.password_hash ?? null,
      ],
    );
    return r.rows[0] as User;
  }
  async listUsers(): Promise<User[]> {
    const r = await this.pool.query("SELECT * FROM users ORDER BY id");
    return r.rows as User[];
  }
  async setUserCredits(id: number, credits: number): Promise<User | undefined> {
    const r = await this.pool.query(
      "UPDATE users SET credits = $1 WHERE id = $2 RETURNING *",
      [credits, id],
    );
    return this.rowToUser(r.rows[0]);
  }
  async decrementCredits(id: number): Promise<User | undefined> {
    const r = await this.pool.query(
      "UPDATE users SET credits = credits - 1 WHERE id = $1 RETURNING *",
      [id],
    );
    return this.rowToUser(r.rows[0]);
  }
  async setUserPassword(id: number, password_hash: string): Promise<User | undefined> {
    const r = await this.pool.query(
      "UPDATE users SET password_hash = $1 WHERE id = $2 RETURNING *",
      [password_hash, id],
    );
    return this.rowToUser(r.rows[0]);
  }

  async createPasswordReset(input: {
    user_id: number;
    code_hash: string;
    created_at: string;
    expires_at: string;
  }): Promise<PasswordReset> {
    const r = await this.pool.query(
      `INSERT INTO password_resets (user_id, code_hash, created_at, expires_at, used_at)
       VALUES ($1, $2, $3, $4, NULL)
       RETURNING *`,
      [input.user_id, input.code_hash, input.created_at, input.expires_at],
    );
    return r.rows[0] as PasswordReset;
  }
  async listActivePasswordResetsForUser(user_id: number): Promise<PasswordReset[]> {
    const r = await this.pool.query(
      `SELECT * FROM password_resets
        WHERE user_id = $1 AND used_at IS NULL
        ORDER BY id DESC`,
      [user_id],
    );
    return r.rows as PasswordReset[];
  }
  async markPasswordResetUsed(id: number, used_at: string): Promise<void> {
    await this.pool.query(
      "UPDATE password_resets SET used_at = $1 WHERE id = $2",
      [used_at, id],
    );
  }
  async invalidateOtherPasswordResets(
    user_id: number,
    except_id: number,
    used_at: string,
  ): Promise<void> {
    await this.pool.query(
      `UPDATE password_resets SET used_at = $1
        WHERE user_id = $2 AND used_at IS NULL AND id <> $3`,
      [used_at, user_id, except_id],
    );
  }

  async appendCreditTransaction(tx: InsertCreditTransaction): Promise<CreditTransaction> {
    const r = await this.pool.query(
      `INSERT INTO credit_transactions
         (user_id, amount_delta, balance_after, reason, reference, provider, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [
        tx.user_id,
        tx.amount_delta,
        tx.balance_after,
        tx.reason,
        tx.reference ?? null,
        tx.provider ?? null,
        tx.created_at,
      ],
    );
    return r.rows[0] as CreditTransaction;
  }
  async listCreditTransactions(user_id: number): Promise<CreditTransaction[]> {
    const r = await this.pool.query(
      "SELECT * FROM credit_transactions WHERE user_id = $1 ORDER BY id DESC",
      [user_id],
    );
    return r.rows as CreditTransaction[];
  }
  async hasUserRedeemedPromo(user_id: number, promo: string): Promise<boolean> {
    const r = await this.pool.query(
      `SELECT 1 FROM credit_transactions
        WHERE user_id = $1 AND reason = 'promo' AND reference = $2
        LIMIT 1`,
      [user_id, promo],
    );
    return r.rowCount! > 0;
  }
  async hasUsedFreeReport(user_id: number): Promise<boolean> {
    const r = await this.pool.query(
      `SELECT 1 FROM credit_transactions
        WHERE user_id = $1 AND reason = 'free_report_claim'
        LIMIT 1`,
      [user_id],
    );
    return r.rowCount! > 0;
  }
  async countFreeReportClaims(opts?: { since?: string; until?: string }): Promise<number> {
    const conds: string[] = ["reason = 'free_report_claim'"];
    const params: any[] = [];
    if (opts?.since) {
      params.push(opts.since);
      conds.push(`created_at >= $${params.length}`);
    }
    if (opts?.until) {
      params.push(opts.until);
      conds.push(`created_at <= $${params.length}`);
    }
    const r = await this.pool.query(
      `SELECT COUNT(*)::int AS n FROM credit_transactions WHERE ${conds.join(" AND ")}`,
      params,
    );
    return Number(r.rows[0]?.n ?? 0);
  }
  async countPurchasesByReferenceSubstring(substring: string): Promise<number> {
    if (!substring) return 0;
    const r = await this.pool.query(
      `SELECT COUNT(*)::int AS n FROM credit_transactions
        WHERE reason = 'purchase' AND reference LIKE $1`,
      [`%${substring}%`],
    );
    return Number(r.rows[0]?.n ?? 0);
  }

  async listResumes(userId: number): Promise<Resume[]> {
    const r = await this.pool.query(
      "SELECT * FROM resumes WHERE created_by = $1 ORDER BY id DESC",
      [userId],
    );
    return r.rows as Resume[];
  }
  async getResume(id: number): Promise<Resume | undefined> {
    const r = await this.pool.query("SELECT * FROM resumes WHERE id = $1", [id]);
    return r.rows[0] as Resume | undefined;
  }
  async createResume(r: InsertResume): Promise<Resume> {
    const out = await this.pool.query(
      `INSERT INTO resumes
         (created_date, created_by, filename, content_type, file_url, extracted_text, size_bytes)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [
        r.created_date,
        r.created_by,
        r.filename,
        r.content_type,
        r.file_url,
        r.extracted_text,
        r.size_bytes,
      ],
    );
    return out.rows[0] as Resume;
  }
  async deleteResume(id: number): Promise<{ changes: number }> {
    const r = await this.pool.query("DELETE FROM resumes WHERE id = $1", [id]);
    return { changes: r.rowCount ?? 0 };
  }

  async listAnalyses(userId: number): Promise<Analysis[]> {
    const r = await this.pool.query(
      "SELECT * FROM analyses WHERE created_by = $1 ORDER BY id DESC",
      [userId],
    );
    return r.rows.map((row) => this.rowToAnalysis(row)!) as Analysis[];
  }
  async getAnalysis(id: number): Promise<Analysis | undefined> {
    const r = await this.pool.query("SELECT * FROM analyses WHERE id = $1", [id]);
    return this.rowToAnalysis(r.rows[0]);
  }
  async createAnalysis(a: InsertAnalysis): Promise<Analysis> {
    const r = await this.pool.query(
      `INSERT INTO analyses
         (created_date, created_by, job_title, job_description, technology_context,
          resume_id, result_text, provider_used, automation_risk, risk_score, is_locked)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING *`,
      [
        a.created_date,
        a.created_by,
        a.job_title,
        a.job_description,
        a.technology_context ?? null,
        a.resume_id ?? null,
        a.result_text,
        a.provider_used,
        a.automation_risk,
        a.risk_score,
        !!a.is_locked,
      ],
    );
    return this.rowToAnalysis(r.rows[0])!;
  }
  async deleteAnalysis(id: number): Promise<{ changes: number }> {
    const r = await this.pool.query("DELETE FROM analyses WHERE id = $1", [id]);
    return { changes: r.rowCount ?? 0 };
  }
  async unlockAnalysis(id: number): Promise<Analysis | undefined> {
    const r = await this.pool.query(
      "UPDATE analyses SET is_locked = FALSE WHERE id = $1 RETURNING *",
      [id],
    );
    return this.rowToAnalysis(r.rows[0]);
  }

  async appendFunnelEvent(ev: InsertFunnelEvent): Promise<FunnelEvent> {
    const r = await this.pool.query(
      `INSERT INTO funnel_events (name, created_at, anon_id, user_id, props, variant, referral_code)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [
        ev.name,
        ev.created_at,
        ev.anon_id ?? null,
        ev.user_id ?? null,
        ev.props ?? null,
        ev.variant ?? null,
        ev.referral_code ?? null,
      ],
    );
    return r.rows[0] as FunnelEvent;
  }
  async countFunnelEvents(opts: {
    name?: string;
    since?: string;
    until?: string;
    variant?: string;
    referral_code?: string;
  }): Promise<number> {
    const conds: string[] = [];
    const params: any[] = [];
    let i = 1;
    if (opts.name) { conds.push(`name = $${i++}`); params.push(opts.name); }
    if (opts.since) { conds.push(`created_at >= $${i++}`); params.push(opts.since); }
    if (opts.until) { conds.push(`created_at <= $${i++}`); params.push(opts.until); }
    if (opts.variant) { conds.push(`variant = $${i++}`); params.push(opts.variant); }
    if (opts.referral_code) { conds.push(`referral_code = $${i++}`); params.push(opts.referral_code); }
    const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
    const r = await this.pool.query(
      `SELECT COUNT(*)::int AS n FROM funnel_events ${where}`,
      params,
    );
    return Number(r.rows[0]?.n ?? 0);
  }
  async aggregateFunnelEvents(opts: { since?: string; until?: string }): Promise<
    Array<{ name: string; count: number }>
  > {
    const conds: string[] = [];
    const params: any[] = [];
    let i = 1;
    if (opts.since) { conds.push(`created_at >= $${i++}`); params.push(opts.since); }
    if (opts.until) { conds.push(`created_at <= $${i++}`); params.push(opts.until); }
    const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
    const r = await this.pool.query(
      `SELECT name, COUNT(*)::int AS count FROM funnel_events ${where}
        GROUP BY name ORDER BY count DESC`,
      params,
    );
    return r.rows.map((row) => ({ name: row.name as string, count: Number(row.count) }));
  }
  async aggregateFunnelEventsByVariant(opts: { name: string; since?: string; until?: string }) {
    const conds: string[] = ["name = $1"];
    const params: any[] = [opts.name];
    let i = 2;
    if (opts.since) { conds.push(`created_at >= $${i++}`); params.push(opts.since); }
    if (opts.until) { conds.push(`created_at <= $${i++}`); params.push(opts.until); }
    const r = await this.pool.query(
      `SELECT variant, COUNT(*)::int AS count FROM funnel_events
        WHERE ${conds.join(" AND ")}
        GROUP BY variant ORDER BY count DESC`,
      params,
    );
    return r.rows.map((row) => ({
      variant: (row.variant ?? null) as string | null,
      count: Number(row.count),
    }));
  }

  async getReferralCodeForUser(user_id: number): Promise<ReferralCode | undefined> {
    const r = await this.pool.query(
      "SELECT * FROM referral_codes WHERE user_id = $1",
      [user_id],
    );
    return r.rows[0] as ReferralCode | undefined;
  }
  async getReferralCodeByCode(code: string): Promise<ReferralCode | undefined> {
    const r = await this.pool.query(
      "SELECT * FROM referral_codes WHERE code = $1",
      [code],
    );
    return r.rows[0] as ReferralCode | undefined;
  }
  async createReferralCode(input: {
    user_id: number;
    code: string;
    created_at: string;
  }): Promise<ReferralCode> {
    const r = await this.pool.query(
      `INSERT INTO referral_codes (user_id, code, created_at)
        VALUES ($1, $2, $3) RETURNING *`,
      [input.user_id, input.code, input.created_at],
    );
    return r.rows[0] as ReferralCode;
  }

  async getPreviewFollowUp(user_id: number, kind: string): Promise<PreviewFollowUp | undefined> {
    const r = await this.pool.query(
      "SELECT * FROM preview_follow_ups WHERE user_id = $1 AND kind = $2",
      [user_id, kind],
    );
    return r.rows[0] as PreviewFollowUp | undefined;
  }
  async createPreviewFollowUp(row: InsertPreviewFollowUp): Promise<PreviewFollowUp> {
    const r = await this.pool.query(
      `INSERT INTO preview_follow_ups
          (user_id, analysis_id, kind, scheduled_for, sent_at, status, reason)
        VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [
        row.user_id,
        row.analysis_id ?? null,
        row.kind,
        row.scheduled_for ?? null,
        row.sent_at ?? null,
        row.status,
        row.reason ?? null,
      ],
    );
    return r.rows[0] as PreviewFollowUp;
  }
  async updatePreviewFollowUp(
    id: number,
    patch: Partial<Pick<PreviewFollowUp, "status" | "sent_at" | "reason">>,
  ): Promise<void> {
    const fields: string[] = [];
    const params: any[] = [];
    let i = 1;
    if (patch.status !== undefined) { fields.push(`status = $${i++}`); params.push(patch.status); }
    if (patch.sent_at !== undefined) { fields.push(`sent_at = $${i++}`); params.push(patch.sent_at); }
    if (patch.reason !== undefined) { fields.push(`reason = $${i++}`); params.push(patch.reason); }
    if (!fields.length) return;
    params.push(id);
    await this.pool.query(
      `UPDATE preview_follow_ups SET ${fields.join(", ")} WHERE id = $${i}`,
      params,
    );
  }
  async listPendingPreviewFollowUps(now: string): Promise<PreviewFollowUp[]> {
    const r = await this.pool.query(
      `SELECT * FROM preview_follow_ups
        WHERE status = 'pending'
          AND (scheduled_for IS NULL OR scheduled_for <= $1)
        ORDER BY id ASC LIMIT 50`,
      [now],
    );
    return r.rows as PreviewFollowUp[];
  }
}

/* =====================================================================
 * Backend selection + bootstrap
 * ===================================================================== */
const SEEDED_OWNER_EMAIL = "roqueta.alex@gmail.com";
const SEEDED_OWNER_TEMP_PASSWORD = "Preview2025!"; // documented in handoff only
const SEEDED_ADMIN_EMAIL = "admin@example.com";
const SEEDED_ADMIN_TEMP_PASSWORD = "AdminPreview2025!"; // documented in handoff only

function isPostgresUrl(url: string | undefined): url is string {
  if (!url) return false;
  const lower = url.trim().toLowerCase();
  return lower.startsWith("postgres://") || lower.startsWith("postgresql://");
}

// Exported so tests/scripts can override storage with an isolated DB
// path (verify-locked-preview etc. already do this).
export let storage: IStorage = null as unknown as IStorage;

/* Test-only helper: force an analysis row to is_locked=true. The public
 * API only exposes unlocking — locking happens implicitly during creation
 * when the actor has zero credits. The payments/credits verification
 * script needs to lock an already-existing analysis to exercise the
 * "unlimited entitlement unlocks without ledger row" path, so we expose
 * a direct setter here. Not part of IStorage to keep the interface
 * narrow. */
export async function _setAnalysisLockedForTest(id: number, locked: boolean): Promise<void> {
  if (storage instanceof SqliteStorage) {
    (storage as any).sqlite
      .prepare("UPDATE analyses SET is_locked = ? WHERE id = ?")
      .run(locked ? 1 : 0, id);
    return;
  }
  if (storage instanceof PostgresStorage) {
    await (storage as any).pool.query(
      "UPDATE analyses SET is_locked = $1 WHERE id = $2",
      [locked, id],
    );
    return;
  }
  throw new Error("_setAnalysisLockedForTest: unknown storage backend");
}

export function setStorage(next: IStorage) {
  storage = next;
}

/* `initStorage` picks the backend, runs migrations, and bootstraps the
 * preview accounts. Returns the active storage instance and also
 * assigns it to the exported `storage` singleton so existing imports
 * (`import { storage } from "./storage"`) work unchanged. Must be
 * awaited before any route handler runs. */
export async function initStorage(opts?: {
  sqlitePath?: string;
  databaseUrl?: string;
}): Promise<IStorage> {
  const url = opts?.databaseUrl ?? process.env.DATABASE_URL;
  let next: IStorage;
  if (isPostgresUrl(url)) {
    const pg = new PostgresStorage(url);
    await pg.migrate();
    next = pg;
    console.log("[storage] using Postgres backend");
  } else {
    next = new SqliteStorage(opts?.sqlitePath ?? "data.db");
    console.log(
      `[storage] using SQLite backend at ${opts?.sqlitePath ?? "data.db"}`,
    );
  }
  storage = next;
  await bootstrap(next);
  return next;
}

/* ---------------------------------------------------------------------
 * Bootstrap the two demo accounts. Idempotent — every startup runs it
 * but it only writes when rows are missing or password_hash is null.
 * ------------------------------------------------------------------- */
async function bootstrap(s: IStorage): Promise<void> {
  const all = await s.listUsers();
  if (all.length === 0) {
    await s.createUser({
      full_name: "Alex Roqueta",
      email: SEEDED_OWNER_EMAIL,
      role: "user",
      credits: 3,
      created_date: new Date().toISOString(),
      password_hash: hashPassword(SEEDED_OWNER_TEMP_PASSWORD),
    });
    await s.createUser({
      full_name: "Jordan Reed (Admin)",
      email: SEEDED_ADMIN_EMAIL,
      role: "admin",
      credits: 999,
      created_date: new Date().toISOString(),
      password_hash: hashPassword(SEEDED_ADMIN_TEMP_PASSWORD),
    });
    return;
  }

  // Backfill the seeded owner row + temp passwords for legacy SQLite
  // databases. The "id=1" rename only applies to SQLite — on Postgres
  // we look up by email instead so a fresh Postgres deploy doesn't
  // clobber an admin account that happens to land at id=1.
  const owner = await s.getUserByEmail(SEEDED_OWNER_EMAIL);
  if (!owner) {
    // Legacy SQLite preview: first row exists but has the wrong email.
    // We only run this rename on SQLite where the legacy demo seeded
    // an arbitrary email; on Postgres a missing owner row is a fresh
    // install and we just create it.
    if (s instanceof SqliteStorage) {
      (s as any).sqlite
        .prepare(
          `UPDATE users SET full_name = ?, email = ? WHERE id = 1
             AND NOT EXISTS (SELECT 1 FROM users WHERE email = ?)`,
        )
        .run("Alex Roqueta", SEEDED_OWNER_EMAIL, SEEDED_OWNER_EMAIL);
    }
    // Create on Postgres (or after the rename above on SQLite, if
    // the rename was a no-op).
    const stillMissing = await s.getUserByEmail(SEEDED_OWNER_EMAIL);
    if (!stillMissing) {
      await s.createUser({
        full_name: "Alex Roqueta",
        email: SEEDED_OWNER_EMAIL,
        role: "user",
        credits: 3,
        created_date: new Date().toISOString(),
        password_hash: hashPassword(SEEDED_OWNER_TEMP_PASSWORD),
      });
    }
  }
  const ownerFinal = await s.getUserByEmail(SEEDED_OWNER_EMAIL);
  if (ownerFinal && !ownerFinal.password_hash) {
    await s.setUserPassword(ownerFinal.id, hashPassword(SEEDED_OWNER_TEMP_PASSWORD));
  }

  const admin = await s.getUserByEmail(SEEDED_ADMIN_EMAIL);
  if (!admin) {
    await s.createUser({
      full_name: "Jordan Reed (Admin)",
      email: SEEDED_ADMIN_EMAIL,
      role: "admin",
      credits: 999,
      created_date: new Date().toISOString(),
      password_hash: hashPassword(SEEDED_ADMIN_TEMP_PASSWORD),
    });
  } else if (!admin.password_hash) {
    await s.setUserPassword(admin.id, hashPassword(SEEDED_ADMIN_TEMP_PASSWORD));
  }
}
