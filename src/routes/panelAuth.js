import { Router } from "express";
import { z } from "zod";
import { hashPassword, verifyPassword } from "../lib/crypto.js";
import * as dto from "../lib/dto.js";
import { badRequest, unauthorized } from "../lib/errors.js";
import { audit } from "../lib/misc.js";
import { endAllSessions, endSession, requirePanel, startSession } from "../middleware/auth.js";
import { loginIpLimit, loginLimit, writeLimit } from "../middleware/rateLimit.js";
import { validate } from "../middleware/validate.js";
import { Notification, User } from "../models/index.js";

const router = Router();

// Set above the per-IP limit, so one attacker cannot lock a real user out on purpose.
const LOCK_AFTER = 20;
const LOCK_MS = 15 * 60_000;

export const passwordRule = z
  .string()
  .min(10, "Use at least 10 characters.")
  .max(128)
  .refine((p) => /[a-zA-Z]/.test(p) && /[^a-zA-Z]/.test(p), "Use letters and at least one number or symbol.");

router.post("/login", loginIpLimit, loginLimit, validate({ body: z.strictObject({ email: z.email().max(120), password: z.string().min(1).max(128) }) }), async (req, res) => {
  const { email, password } = req.valid.body;
  const fail = () => unauthorized("Wrong email or password.");
  const user = await User.findOne({ email: email.toLowerCase(), role: { $ne: "customer" } }).select("+passwordHash +failedLogins +lockedUntil");

  // Hash even when there is no account, so response time does not reveal which emails exist.
  const ok = await verifyPassword(password, user?.passwordHash);
  if (!user) throw fail();
  if (user.lockedUntil && user.lockedUntil > new Date()) throw fail();
  if (!ok || user.status !== "active") {
    const failedLogins = (user.failedLogins ?? 0) + 1;
    await User.updateOne({ _id: user._id }, failedLogins >= LOCK_AFTER ? { $set: { failedLogins: 0, lockedUntil: new Date(Date.now() + LOCK_MS) } } : { $set: { failedLogins } });
    req.user = user;
    audit(req, "auth", "login_failed", `Failed login for ${user.email}`, user._id);
    throw fail();
  }
  await User.updateOne({ _id: user._id }, { $set: { failedLogins: 0 }, $unset: { lockedUntil: 1 } });
  await startSession(req, res, user, "panel");
  req.user = user;
  audit(req, "auth", "login", `${user.name} signed in`, user._id);
  res.json({ user: dto.panelUser(user) });
});

router.get("/me", requirePanel, (req, res) => res.json({ user: dto.panelUser(req.user) }));

router.post("/logout", async (req, res) => {
  await endSession(req, res, "panel");
  res.json({ ok: true });
});

router.post("/password", requirePanel, writeLimit, validate({ body: z.strictObject({ current: z.string().max(128), next: passwordRule }) }), async (req, res) => {
  const user = await User.findById(req.user._id).select("+passwordHash");
  if (!(await verifyPassword(req.valid.body.current, user.passwordHash))) throw badRequest("Your current password is wrong.");
  user.passwordHash = await hashPassword(req.valid.body.next);
  await user.save();
  // Any session left open on another device ends here.
  await endAllSessions(user._id);
  await startSession(req, res, user, "panel");
  audit(req, "auth", "password_change", `${user.name} changed their password`, user._id);
  res.json({ ok: true });
});

router.get("/notifications", requirePanel, async (req, res) => {
  const rows = await Notification.find({ userId: req.user._id }).sort({ createdAt: -1 }).limit(30).lean();
  res.json({ notifications: rows.map(dto.notification) });
});

router.post("/notifications/read-all", requirePanel, async (req, res) => {
  await Notification.updateMany({ userId: req.user._id, unread: true }, { $set: { unread: false } });
  res.json({ ok: true });
});

export default router;
