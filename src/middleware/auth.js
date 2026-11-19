import { env } from "../config/env.js";
import { effectivePermissions } from "../config/permissions.js";
import { randomToken, sha256 } from "../lib/crypto.js";
import { forbidden, unauthorized } from "../lib/errors.js";
import { Session, User } from "../models/index.js";

/**
 * Opaque sessions in httpOnly cookies. Page scripts can never read the token, and disabling an
 * account or changing its role takes effect on the very next request, unlike a JWT.
 * Customer and panel sessions use separate cookies, so one can never act as the other.
 */
const COOKIE = { customer: "ps_c", panel: "ps_p" };
const TTL = { customer: 30 * 86400_000, panel: 12 * 3600_000 };
// A phone stays signed in longer; the app keeps the token in the device's secure storage.
const APP_TTL = { customer: 180 * 86400_000, panel: 7 * 86400_000 };
const ttlFor = (req, audience) => (req.appClient ? APP_TTL : TTL)[audience];
const tokenOf = (req, audience) => (req.appClient ? req.appToken : req.cookies?.[COOKIE[audience]]);

const cookieOptions = (audience) => ({ httpOnly: true, secure: env.isProd, sameSite: "lax", path: "/", maxAge: TTL[audience] });

/** Starts a session. Browsers get an httpOnly cookie; the app gets the token back to keep itself. */
export async function startSession(req, res, user, audience) {
  const token = randomToken();
  await Session.create({ tokenHash: sha256(token), userId: user._id, audience, expiresAt: new Date(Date.now() + ttlFor(req, audience)), userAgent: String(req.get("user-agent") ?? "").slice(0, 200), ip: req.ip });
  if (!req.appClient) res.cookie(COOKIE[audience], token, cookieOptions(audience));
  await User.updateOne({ _id: user._id }, { $set: { lastLoginAt: new Date() } });
  return req.appClient ? token : undefined;
}

export async function endSession(req, res, audience) {
  const token = tokenOf(req, audience);
  if (token) await Session.deleteOne({ tokenHash: sha256(token) });
  if (req.appClient) return;
  res.clearCookie(COOKIE[audience], { ...cookieOptions(audience), maxAge: undefined });
}

export const endAllSessions = (userId) => Session.deleteMany({ userId });

async function load(req, audience) {
  const token = tokenOf(req, audience);
  if (!token || token.length > 100) return null;
  const session = await Session.findOne({ tokenHash: sha256(token), audience, expiresAt: { $gt: new Date() } }).lean();
  if (!session) return null;
  const user = await User.findById(session.userId);
  if (!user || user.status !== "active") return null;
  return user;
}

export const optionalCustomer = async (req, _res, next) => {
  try {
    req.user = await load(req, "customer");
    next();
  } catch (e) {
    next(e);
  }
};

export const requireCustomer = async (req, _res, next) => {
  try {
    const user = await load(req, "customer");
    if (!user || user.role !== "customer") return next(unauthorized());
    req.user = user;
    next();
  } catch (e) {
    next(e);
  }
};

export const requirePanel = async (req, _res, next) => {
  try {
    const user = await load(req, "panel");
    if (!user || user.role === "customer") return next(unauthorized());
    req.user = user;
    req.permissions = new Set(effectivePermissions(user));
    next();
  } catch (e) {
    next(e);
  }
};

/** Passes when the account has at least one of the permissions. */
export const can = (...perms) => (req, _res, next) => (perms.some((p) => req.permissions?.has(p)) ? next() : next(forbidden()));
