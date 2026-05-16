import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

/**
 * Server-side password hashing using Node's built-in scrypt.
 *
 * Format: "scrypt$N$r$p$<saltHex>$<keyHex>"
 *
 * Parameters chosen for a preview app: N=16384 (2^14), r=8, p=1, keyLen=64.
 * These match Node's defaults and keep verify time comfortably under
 * ~100ms on modest hardware while still being memory-hard.
 *
 * The hash format includes the parameters so we can tune them in the
 * future without breaking already-stored hashes.
 */

const N = 16384;
const R = 8;
const P = 1;
const KEY_LEN = 64;
const SALT_BYTES = 16;

export function hashPassword(plaintext: string): string {
  const salt = randomBytes(SALT_BYTES);
  const key = scryptSync(plaintext, salt, KEY_LEN, { N, r: R, p: P });
  return `scrypt$${N}$${R}$${P}$${salt.toString("hex")}$${key.toString("hex")}`;
}

export function verifyPassword(plaintext: string, stored: string | null | undefined): boolean {
  if (!stored) return false;
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isFinite(n) || !Number.isFinite(r) || !Number.isFinite(p)) return false;
  let salt: Buffer;
  let key: Buffer;
  try {
    salt = Buffer.from(parts[4], "hex");
    key = Buffer.from(parts[5], "hex");
  } catch {
    return false;
  }
  if (salt.length === 0 || key.length === 0) return false;
  let derived: Buffer;
  try {
    derived = scryptSync(plaintext, salt, key.length, { N: n, r, p });
  } catch {
    return false;
  }
  if (derived.length !== key.length) return false;
  return timingSafeEqual(derived, key);
}
