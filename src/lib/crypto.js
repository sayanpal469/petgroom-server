import crypto from "node:crypto";
import { promisify } from "node:util";
import { env } from "../config/env.js";

const scrypt = promisify(crypto.scrypt);
const SCRYPT = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

/** scrypt runs on the libuv pool, so hashing never blocks the event loop. */
export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, 32, SCRYPT);
  return `s1$${salt.toString("base64")}$${key.toString("base64")}`;
}

export async function verifyPassword(password, stored) {
  const [, saltB64, keyB64] = (stored ?? "").split("$");
  // Unknown accounts still cost a full hash, so timing does not reveal which emails exist.
  const salt = saltB64 ? Buffer.from(saltB64, "base64") : Buffer.alloc(16);
  const expected = keyB64 ? Buffer.from(keyB64, "base64") : Buffer.alloc(32);
  const key = await scrypt(password, salt, 32, SCRYPT);
  return crypto.timingSafeEqual(key, expected) && Boolean(stored);
}

export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString("base64url");
export const sha256 = (v) => crypto.createHash("sha256").update(v).digest("hex");
export const hmac = (v) => crypto.createHmac("sha256", env.dataKey).update(v).digest("hex");
export const randomDigits = (n) => String(crypto.randomInt(0, 10 ** n)).padStart(n, "0");

export function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

export function seal(plain, key = env.dataKey) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), body]).toString("base64url");
}

export function unseal(sealed, key = env.dataKey) {
  const raw = Buffer.from(sealed, "base64url");
  const d = crypto.createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12));
  d.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([d.update(raw.subarray(28)), d.final()]);
}
