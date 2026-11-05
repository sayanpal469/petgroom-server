import { env } from "../config/env.js";
import { Settings } from "../models/index.js";
import { safeEqual, seal, unseal } from "./crypto.js";
import { ApiError } from "./errors.js";

/**
 * Login OTP through Message Central VerifyNow. Credentials are set from the admin panel and kept
 * in their own settings document, so the store bootstrap can never include them. The password and
 * the auth token are sealed with DATA_SECRET and are never sent back to a browser.
 *
 * Either secret works: a saved auth token (from the Message Central dashboard) is used as it is,
 * otherwise a fresh token is requested with the password.
 */
const BASE = "https://cpaas.messagecentral.com";
export const OTP_LENGTH = 4;
const CACHE_MS = env.isTest ? 0 : 15_000;
const TOKEN_MS = 30 * 60_000;

const DEFAULTS = { enabled: false, customerId: "", passwordSealed: "", tokenSealed: "", demoEnabled: false, demoPhone: "", demoCode: "" };

let cached = null;
let cachedAt = 0;
let token = null;

export async function getSmsConfig() {
  if (cached && Date.now() - cachedAt < CACHE_MS) return cached;
  const doc = await Settings.findById("sms").lean();
  cached = { ...DEFAULTS, ...(doc?.data ?? {}) };
  cachedAt = Date.now();
  return cached;
}

export async function saveSmsConfig({ password, authToken: newToken, ...patch }) {
  const next = { ...(await getSmsConfig()), ...patch };
  if (password) next.passwordSealed = seal(Buffer.from(password));
  if (newToken) next.tokenSealed = seal(Buffer.from(newToken));
  await Settings.updateOne({ _id: "sms" }, { $set: { data: next } }, { upsert: true });
  cached = next;
  cachedAt = Date.now();
  token = null;
  return next;
}

export const smsView = (c) => ({ enabled: c.enabled, customerId: c.customerId, hasPassword: Boolean(c.passwordSealed), hasToken: Boolean(c.tokenSealed), demoEnabled: c.demoEnabled, demoPhone: c.demoPhone, demoCode: c.demoCode });

export const isDemoPhone = (c, phone) => c.demoEnabled && Boolean(c.demoPhone) && c.demoPhone === phone;
export const isDemoLogin = (c, phone, code) => isDemoPhone(c, phone) && Boolean(c.demoCode) && safeEqual(c.demoCode, code);
export const hasSecret = (c) => Boolean(c.passwordSealed || c.tokenSealed);
export const providerReady = (c) => c.enabled && Boolean(c.customerId) && hasSecret(c);

const down = () => new ApiError(503, "Couldn't send the OTP right now. Please try again shortly.", "sms_failed");

async function call(url, init) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(8000) });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function authToken(c) {
  if (c.tokenSealed) return unseal(c.tokenSealed).toString();
  if (token && token.customerId === c.customerId && token.until > Date.now()) return token.value;
  const q = new URLSearchParams({ customerId: c.customerId, key: unseal(c.passwordSealed).toString("base64"), scope: "NEW", country: "91" });
  const { status, body } = await call(`${BASE}/auth/v1/authentication/token?${q}`, { headers: { accept: "*/*" } });
  if (status !== 200 || !body?.token) throw new Error(`Message Central token request failed (${status})`);
  token = { value: body.token, customerId: c.customerId, until: Date.now() + TOKEN_MS };
  return body.token;
}

/** Used by the Test button: proves the Customer ID and secret are right, without sending an SMS. */
export const testConnection = async (c) => {
  token = null;
  const value = await authToken(c);
  if (!c.tokenSealed) return;
  // A saved token is only checked when used, so ask about a verification that cannot exist:
  // a good token gets "invalid verificationId", a bad one gets 401.
  const q = new URLSearchParams({ countryCode: "91", mobileNumber: "9000000000", verificationId: "0", customerId: c.customerId, code: "0000", flowType: "SMS" });
  const { status } = await call(`${BASE}/verification/v3/validateOtp?${q}`, { headers: { authToken: value } });
  if (status === 401 || status === 403) throw new Error(`Message Central refused the auth token (${status})`);
};

export async function sendOtp(c, phone) {
  const q = new URLSearchParams({ countryCode: "91", customerId: c.customerId, flowType: "SMS", mobileNumber: phone, otpLength: String(OTP_LENGTH) });
  const { status, body } = await call(`${BASE}/verification/v3/send?${q}`, { method: "POST", headers: { authToken: await authToken(c) } });
  // 506: an OTP sent moments ago is still valid, so the customer keeps using that one.
  if (body?.responseCode === 506) return { reused: true };
  const verificationId = body?.data?.verificationId;
  if (status !== 200 || !verificationId) throw down();
  return { verificationId: String(verificationId) };
}

export async function checkOtp(c, phone, verificationId, code) {
  const q = new URLSearchParams({ countryCode: "91", mobileNumber: phone, verificationId, customerId: c.customerId, code, flowType: "SMS" });
  const { body } = await call(`${BASE}/verification/v3/validateOtp?${q}`, { headers: { authToken: await authToken(c) } });
  return body?.data?.verificationStatus === "VERIFICATION_COMPLETED";
}
