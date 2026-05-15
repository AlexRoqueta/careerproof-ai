import {
  users,
  resumes,
  analyses,
  passwordResets,
  creditTransactions,
  type User,
  type InsertUser,
  type Resume,
  type InsertResume,
  type Analysis,
  type InsertAnalysis,
  type PasswordReset,
  type CreditTransaction,
  type InsertCreditTransaction,
} from "@shared/schema";
import { drizzle } from "drizzle-orm/better-sqlite3";
import Database from "better-sqlite3";
import { eq, desc, sql, and, isNull } from "drizzle-orm";
import { hashPassword } from "./password";

const sqlite = new Database("data.db");
sqlite.pragma("journal_mode = WAL");

// Ensure tables exist. drizzle-kit push is the canonical path, but a
// quick CREATE TABLE IF NOT EXISTS keeps dev startup zero-config.
sqlite.exec(`
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
`);

// Forward-compatible additive migration for existing databases that
// were created before the is_locked column existed.
try {
  const cols = sqlite.prepare("PRAGMA table_info(analyses)").all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === "is_locked")) {
    sqlite.exec("ALTER TABLE analyses ADD COLUMN is_locked INTEGER NOT NULL DEFAULT 0");
  }
} catch {
  // Safe to ignore — the CREATE TABLE above already adds the column on
  // fresh databases.
}

// Additive migration for password_hash on existing user tables.
try {
  const cols = sqlite.prepare("PRAGMA table_info(users)").all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === "password_hash")) {
    sqlite.exec("ALTER TABLE users ADD COLUMN password_hash TEXT");
  }
} catch {
  // Safe to ignore — the CREATE TABLE above already adds the column on
  // fresh databases.
}

export const db = drizzle(sqlite);

export interface IStorage {
  // Users
  getUser(id: number): User | undefined;
  getUserByEmail(email: string): User | undefined;
  createUser(user: InsertUser): User;
  listUsers(): User[];
  setUserCredits(id: number, credits: number): User | undefined;
  decrementCredits(id: number): User | undefined;
  setUserPassword(id: number, password_hash: string): User | undefined;
  // Password reset codes
  createPasswordReset(input: {
    user_id: number;
    code_hash: string;
    created_at: string;
    expires_at: string;
  }): PasswordReset;
  listActivePasswordResetsForUser(user_id: number): PasswordReset[];
  markPasswordResetUsed(id: number, used_at: string): void;
  invalidateOtherPasswordResets(user_id: number, except_id: number, used_at: string): void;
  // Credit ledger
  appendCreditTransaction(tx: InsertCreditTransaction): CreditTransaction;
  listCreditTransactions(user_id: number): CreditTransaction[];
  hasUserRedeemedPromo(user_id: number, promo_code_reference: string): boolean;
  // Resumes
  listResumes(userId: number): Resume[];
  getResume(id: number): Resume | undefined;
  createResume(resume: InsertResume): Resume;
  deleteResume(id: number): { changes: number };
  // Analyses
  listAnalyses(userId: number): Analysis[];
  getAnalysis(id: number): Analysis | undefined;
  createAnalysis(analysis: InsertAnalysis): Analysis;
  deleteAnalysis(id: number): { changes: number };
  unlockAnalysis(id: number): Analysis | undefined;
}

export class DatabaseStorage implements IStorage {
  getUser(id: number): User | undefined {
    return db.select().from(users).where(eq(users.id, id)).get();
  }
  getUserByEmail(email: string): User | undefined {
    return db.select().from(users).where(eq(users.email, email)).get();
  }
  createUser(insertUser: InsertUser): User {
    return db.insert(users).values(insertUser).returning().get();
  }
  listUsers(): User[] {
    return db.select().from(users).orderBy(users.id).all();
  }
  setUserCredits(id: number, credits: number): User | undefined {
    return db.update(users).set({ credits }).where(eq(users.id, id)).returning().get();
  }
  decrementCredits(id: number): User | undefined {
    return db
      .update(users)
      .set({ credits: sql`${users.credits} - 1` })
      .where(eq(users.id, id))
      .returning()
      .get();
  }
  setUserPassword(id: number, password_hash: string): User | undefined {
    return db
      .update(users)
      .set({ password_hash })
      .where(eq(users.id, id))
      .returning()
      .get();
  }

  createPasswordReset(input: {
    user_id: number;
    code_hash: string;
    created_at: string;
    expires_at: string;
  }): PasswordReset {
    return db.insert(passwordResets).values({ ...input, used_at: null }).returning().get();
  }
  listActivePasswordResetsForUser(user_id: number): PasswordReset[] {
    return db
      .select()
      .from(passwordResets)
      .where(and(eq(passwordResets.user_id, user_id), isNull(passwordResets.used_at)))
      .orderBy(desc(passwordResets.id))
      .all();
  }
  markPasswordResetUsed(id: number, used_at: string): void {
    db.update(passwordResets).set({ used_at }).where(eq(passwordResets.id, id)).run();
  }
  invalidateOtherPasswordResets(user_id: number, except_id: number, used_at: string): void {
    db.update(passwordResets)
      .set({ used_at })
      .where(
        and(
          eq(passwordResets.user_id, user_id),
          isNull(passwordResets.used_at),
          sql`${passwordResets.id} != ${except_id}`,
        ),
      )
      .run();
  }

  appendCreditTransaction(tx: InsertCreditTransaction): CreditTransaction {
    return db.insert(creditTransactions).values(tx).returning().get();
  }
  listCreditTransactions(user_id: number): CreditTransaction[] {
    return db
      .select()
      .from(creditTransactions)
      .where(eq(creditTransactions.user_id, user_id))
      .orderBy(desc(creditTransactions.id))
      .all();
  }
  hasUserRedeemedPromo(user_id: number, promo_code_reference: string): boolean {
    // A promo code is considered "already redeemed" when ANY credit
    // transaction with reason='promo' and reference=<code> exists for
    // this user — regardless of how many credits it granted. This is
    // ledger-driven so the rule survives admin balance adjustments
    // without needing a separate redemption table.
    const hit = db
      .select()
      .from(creditTransactions)
      .where(
        and(
          eq(creditTransactions.user_id, user_id),
          eq(creditTransactions.reason, "promo"),
          eq(creditTransactions.reference, promo_code_reference),
        ),
      )
      .limit(1)
      .get();
    return !!hit;
  }

  listResumes(userId: number): Resume[] {
    return db
      .select()
      .from(resumes)
      .where(eq(resumes.created_by, userId))
      .orderBy(desc(resumes.id))
      .all();
  }
  getResume(id: number): Resume | undefined {
    return db.select().from(resumes).where(eq(resumes.id, id)).get();
  }
  createResume(resume: InsertResume): Resume {
    return db.insert(resumes).values(resume).returning().get();
  }
  deleteResume(id: number): { changes: number } {
    return db.delete(resumes).where(eq(resumes.id, id)).run();
  }

  listAnalyses(userId: number): Analysis[] {
    return db
      .select()
      .from(analyses)
      .where(eq(analyses.created_by, userId))
      .orderBy(desc(analyses.id))
      .all();
  }
  getAnalysis(id: number): Analysis | undefined {
    return db.select().from(analyses).where(eq(analyses.id, id)).get();
  }
  createAnalysis(analysis: InsertAnalysis): Analysis {
    return db.insert(analyses).values(analysis).returning().get();
  }
  deleteAnalysis(id: number): { changes: number } {
    return db.delete(analyses).where(eq(analyses.id, id)).run();
  }
  unlockAnalysis(id: number): Analysis | undefined {
    return db
      .update(analyses)
      .set({ is_locked: false })
      .where(eq(analyses.id, id))
      .returning()
      .get();
  }
}

export const storage = new DatabaseStorage();

/* ---------------------------------------------------------------------
 * Bootstrap a demo current user + an admin user on first run.
 * Auth is simulated — the "current user" is the first row by default,
 * but the client can switch via /api/me/switch (for admin-role testing).
 * --------------------------------------------------------------------- */
/* ---------------------------------------------------------------------
 * Deterministic preview-only passwords for the two seeded accounts.
 *
 * IMPORTANT: these values are intentionally NOT shown anywhere in the
 * UI. They exist so an internal reviewer / handoff document can sign
 * into the pre-seeded accounts for testing. Any real deployment should
 * rotate these immediately or force a password reset.
 * ------------------------------------------------------------------ */
const SEEDED_OWNER_EMAIL = "roqueta.alex@gmail.com";
const SEEDED_OWNER_TEMP_PASSWORD = "Preview2025!"; // documented in handoff only
const SEEDED_ADMIN_EMAIL = "admin@example.com";
const SEEDED_ADMIN_TEMP_PASSWORD = "AdminPreview2025!"; // documented in handoff only

function bootstrap() {
  const all = storage.listUsers();
  if (all.length === 0) {
    storage.createUser({
      full_name: "Alex Roqueta",
      email: SEEDED_OWNER_EMAIL,
      role: "user",
      credits: 3,
      created_date: new Date().toISOString(),
      password_hash: hashPassword(SEEDED_OWNER_TEMP_PASSWORD),
    });
    storage.createUser({
      full_name: "Jordan Reed (Admin)",
      email: SEEDED_ADMIN_EMAIL,
      role: "admin",
      credits: 999,
      created_date: new Date().toISOString(),
      password_hash: hashPassword(SEEDED_ADMIN_TEMP_PASSWORD),
    });
  } else {
    // Demo-auth bootstrap: make the default logged-in account match the
    // owner's email entitlement. Production auth can use the best-fit
    // provider for the deployed environment.
    db
      .update(users)
      .set({ full_name: "Alex Roqueta", email: SEEDED_OWNER_EMAIL })
      .where(eq(users.id, 1))
      .run();

    // Backfill the preview passwords for the two seeded accounts ONLY
    // if they currently have no password_hash. We never overwrite a
    // password that an account holder has already set themselves.
    const owner = storage.getUserByEmail(SEEDED_OWNER_EMAIL);
    if (owner && !owner.password_hash) {
      storage.setUserPassword(owner.id, hashPassword(SEEDED_OWNER_TEMP_PASSWORD));
    }
    const admin = storage.getUserByEmail(SEEDED_ADMIN_EMAIL);
    if (admin && !admin.password_hash) {
      storage.setUserPassword(admin.id, hashPassword(SEEDED_ADMIN_TEMP_PASSWORD));
    }
  }
}
bootstrap();
