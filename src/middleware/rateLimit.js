import { rateLimit } from "express-rate-limit";
import { RateCounter } from "../models/index.js";
import { env } from "../config/env.js";
import { ApiError } from "../lib/errors.js";
import { getSmsConfig, isDemoPhone } from "../lib/sms.js";

/**
 * Sensitive limits are kept in Mongo so they hold across all workers and servers.
 * The general limiter stays in process memory: it runs on every request and must not
 * add a database round trip.
 */
class MongoStore {
  constructor(prefix) {
    this.prefix = prefix;
    this.localKeys = false;
  }
  init(options) {
    this.windowMs = options.windowMs;
  }
  async get(key) {
    const doc = await RateCounter.findById(`${this.prefix}:${key}`).lean();
    return doc ? { totalHits: doc.hits, resetTime: doc.expiresAt } : undefined;
  }
  async increment(key) {
    const _id = `${this.prefix}:${key}`;
    const now = new Date();
    const live = { $gt: [{ $ifNull: ["$expiresAt", now] }, now] };
    const doc = await RateCounter.findOneAndUpdate(
      { _id },
      [
        {
          $set: {
            hits: { $cond: [live, { $add: ["$hits", 1] }, 1] },
            expiresAt: { $cond: [live, "$expiresAt", new Date(now.getTime() + this.windowMs)] },
          },
        },
      ],
      { upsert: true, returnDocument: "after", updatePipeline: true },
    ).lean();
    return { totalHits: doc.hits, resetTime: doc.expiresAt };
  }
  async decrement(key) {
    await RateCounter.updateOne({ _id: `${this.prefix}:${key}` }, { $inc: { hits: -1 } });
  }
  async resetKey(key) {
    await RateCounter.deleteOne({ _id: `${this.prefix}:${key}` });
  }
}

const limited = (message) => (_req, _res, next) => next(new ApiError(429, message, "rate_limited"));
const testBypass = env.isTest && process.env.TEST_RATE_LIMITS !== "1";

const make = ({ prefix, windowMs, limit, message, key, skip, shared = true, skipSuccessfulRequests = false }) =>
  rateLimit({
    windowMs,
    limit: testBypass ? 1_000_000 : limit,
    standardHeaders: false,
    legacyHeaders: false,
    skipSuccessfulRequests,
    // The tunnel always answers HTTP 200, so success is judged on the real status.
    requestWasSuccessful: (_req, res) => (res.locals.realStatus ?? res.statusCode) < 400,
    keyGenerator: key ?? ((req) => req.ip),
    validate: false,
    ...(skip ? { skip } : {}),
    handler: limited(message),
    ...(shared ? { store: new MongoStore(prefix) } : {}),
  });

const MIN = 60_000;

/** Every request, per client IP, per worker. Generous enough for a whole store counter behind one IP. */
export const generalLimit = make({ prefix: "gen", windowMs: MIN, limit: 600, shared: false, message: "Too many requests. Please slow down." });
export const handshakeLimit = make({ prefix: "hs", windowMs: MIN, limit: 120, shared: false, message: "Too many requests. Please slow down." });

export const otpIpLimit = make({ prefix: "otp-ip", windowMs: 15 * MIN, limit: 15, message: "Too many OTP requests. Try again in a few minutes." });
export const otpPhoneLimit = make({
  prefix: "otp-ph",
  windowMs: 15 * MIN,
  limit: 4,
  key: (req) => String(req.body?.phone ?? "none"),
  // The demo number sends no SMS, so there is nothing to limit.
  skip: async (req) => isDemoPhone(await getSmsConfig(), String(req.body?.phone ?? "")),
  message: "Too many OTPs for this number. Try again in 15 minutes.",
});
export const otpVerifyLimit = make({
  prefix: "otp-v",
  windowMs: 15 * MIN,
  limit: 12,
  key: (req) => String(req.body?.phone ?? req.ip),
  message: "Too many attempts. Try again in 15 minutes.",
});
export const loginLimit = make({
  prefix: "login",
  windowMs: 15 * MIN,
  limit: 8,
  skipSuccessfulRequests: true,
  key: (req) => `${req.ip}:${String(req.body?.email ?? "").toLowerCase()}`,
  message: "Too many login attempts. Try again in 15 minutes.",
});
export const loginIpLimit = make({ prefix: "login-ip", windowMs: 15 * MIN, limit: 40, skipSuccessfulRequests: true, message: "Too many login attempts. Try again later." });
export const pickupOtpLimit = make({ prefix: "pickup", windowMs: 10 * MIN, limit: 15, key: (req) => String(req.user?._id ?? req.ip), message: "Too many OTP attempts. Wait a few minutes." });
export const writeLimit = make({ prefix: "write", windowMs: MIN, limit: 30, key: (req) => String(req.user?._id ?? req.ip), message: "Too many requests. Please slow down." });
export const enquiryLimit = make({ prefix: "enq", windowMs: 60 * MIN, limit: 5, message: "Too many messages. Please try again later." });
export const uploadLimit = make({ prefix: "up", windowMs: 10 * MIN, limit: 60, key: (req) => String(req.user?._id ?? req.ip), message: "Too many uploads. Wait a few minutes." });
