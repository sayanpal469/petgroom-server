import crypto from "node:crypto";
import { env } from "../config/env.js";
import { Settings } from "../models/index.js";
import { safeEqual, seal, unseal } from "./crypto.js";
import { ApiError } from "./errors.js";

/**
 * Razorpay, for the booking amount. Keys are set from the admin panel and kept in their own
 * settings document, so the store bootstrap can never include them. The key secret is sealed
 * with DATA_SECRET and never sent back to a browser; only the public key id is.
 *
 * Amounts in this file are in paise, as Razorpay expects.
 */
const BASE = "https://api.razorpay.com/v1";
const CACHE_MS = env.isTest ? 0 : 15_000;
const DEFAULTS = { enabled: false, keyId: "", secretSealed: "" };

let cached = null;
let cachedAt = 0;

export async function getPayConfig() {
  if (cached && Date.now() - cachedAt < CACHE_MS) return cached;
  const doc = await Settings.findById("payments").lean();
  cached = { ...DEFAULTS, ...(doc?.data ?? {}) };
  cachedAt = Date.now();
  return cached;
}

export async function savePayConfig({ keySecret, ...patch }) {
  const next = { ...(await getPayConfig()), ...patch };
  if (keySecret) next.secretSealed = seal(Buffer.from(keySecret));
  await Settings.updateOne({ _id: "payments" }, { $set: { data: next } }, { upsert: true });
  cached = next;
  cachedAt = Date.now();
  return next;
}

export const payView = (c) => ({ enabled: c.enabled, keyId: c.keyId, hasSecret: Boolean(c.secretSealed), testMode: c.keyId.startsWith("rzp_test_") });
export const payReady = (c) => c.enabled && Boolean(c.keyId) && Boolean(c.secretSealed);

const secretOf = (c) => unseal(c.secretSealed).toString();

/** Tests replace the network call; production always talks to Razorpay. */
let transport = async (url, init) => {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(10_000) });
  return { status: res.status, body: await res.json().catch(() => null) };
};
export const setPaymentTransport = (fn) => {
  transport = fn;
};

const down = () => new ApiError(503, "The payment service isn't answering right now. Please try again shortly.", "payment_unavailable");

async function rz(c, method, path, body) {
  const auth = Buffer.from(`${c.keyId}:${secretOf(c)}`).toString("base64");
  const { status, body: out } = await transport(`${BASE}${path}`, {
    method,
    headers: { authorization: `Basic ${auth}`, "content-type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  }).catch(() => {
    throw down();
  });
  if (status === 401) throw new ApiError(503, "Online payment isn't set up correctly. Please call the store.", "payment_unavailable");
  if (status >= 400) {
    const err = new ApiError(502, out?.error?.description ?? "The payment service refused the request.", "payment_failed");
    err.gateway = out?.error;
    throw err;
  }
  return out;
}

export const createOrder = (c, { amount, receipt, notes }) => rz(c, "POST", "/orders", { amount, currency: "INR", receipt, notes });
export const fetchPayment = (c, id) => rz(c, "GET", `/payments/${encodeURIComponent(id)}`);
export const capturePayment = (c, id, amount) => rz(c, "POST", `/payments/${encodeURIComponent(id)}/capture`, { amount, currency: "INR" });
export const orderPayments = async (c, orderId) => (await rz(c, "GET", `/orders/${encodeURIComponent(orderId)}/payments`))?.items ?? [];
export const refundPayment = (c, id, amount, notes) => rz(c, "POST", `/payments/${encodeURIComponent(id)}/refund`, { amount, speed: "normal", notes });

/** Used by the Test button: a wrong key id or secret gets 401. */
export const testKeys = (c) => rz(c, "GET", "/orders?count=1");

/** Razorpay signs `order_id|payment_id` with the key secret. Only our server can check it. */
export function signatureValid(c, orderId, paymentId, signature) {
  const expected = crypto.createHmac("sha256", secretOf(c)).update(`${orderId}|${paymentId}`).digest("hex");
  return safeEqual(expected, String(signature));
}
