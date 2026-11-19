import { Router } from "express";
import { z } from "zod";
import { env } from "../config/env.js";
import { effectivePermissions } from "../config/permissions.js";
import { sha256 } from "../lib/crypto.js";
import * as dto from "../lib/dto.js";
import { ApiError, badRequest, conflict, forbidden, notFound } from "../lib/errors.js";
import { distanceM, shopOf } from "../lib/geo.js";
import { logger } from "../lib/logger.js";
import { billTotals } from "../lib/money.js";
import { assignTrip, newCollectCode, stepTrip } from "../lib/pickdrop.js";
import { addDaysISO, audit, getSettings, storeNow } from "../lib/misc.js";
import { fillTemplate, getSmsConfig, sendText, textReady } from "../lib/sms.js";
import { can } from "../middleware/auth.js";
import { pickupOtpLimit, writeLimit } from "../middleware/rateLimit.js";
import { idParams, isoDate, objectId, text, validate } from "../middleware/validate.js";
import { Attendance, Booking, Enquiry, Groomer, Invoice, Pet, User } from "../models/index.js";
import { checkLeadSource } from "./customer.js";

const router = Router();
const has = (req, ...p) => p.some((x) => req.permissions.has(x));
const range = z.strictObject({ from: isoDate, to: isoDate });
const dayStart = (d) => new Date(`${d}T00:00:00+05:30`);
const dayEnd = (d) => new Date(`${d}T23:59:59.999+05:30`);

function checkRange({ from, to }, maxDays) {
  if (to < from) throw badRequest("The end date is before the start date.");
  if (addDaysISO(from, maxDays) < to) throw badRequest(`Choose a period of ${maxDays} days or less.`);
}

/* ---------- Attendance: marked from the shop only, checked against the shop location. ---------- */

const punchBody = z.strictObject({
  kind: z.enum(["in", "out"]),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  accuracy: z.number().min(0).max(100_000),
  deviceId: z.string().regex(/^[\w-]{16,64}$/),
});

/** GPS readings worse than this can't prove the person is inside the shop area. */
const MAX_ACCURACY_M = 150;

router.get("/attendance/me", can("attendance.own"), async (req, res) => {
  const settings = await getSettings();
  const today = storeNow().date;
  const [row, user, recent] = await Promise.all([
    Attendance.findOne({ userId: req.user._id, date: today }).lean(),
    User.findById(req.user._id).select("+attendanceDevice").lean(),
    Attendance.find({ userId: req.user._id }).sort({ date: -1 }).limit(14).lean(),
  ]);
  res.json({
    today: row ? dto.attendance(row) : null,
    recent: recent.map(dto.attendance),
    shopSet: Boolean(shopOf(settings)),
    radius: settings.attendanceRadius,
    deviceBound: Boolean(user?.attendanceDevice),
  });
});

router.post("/attendance/mark", can("attendance.own"), writeLimit, validate({ body: punchBody }), async (req, res) => {
  const { kind, lat, lng, accuracy, deviceId } = req.valid.body;
  const settings = await getSettings();
  const shop = shopOf(settings);
  if (!shop) throw conflict("The shop location isn't set yet. Ask an administrator to set it in Settings.", "shop_not_set");

  // One phone per person, so nobody can mark attendance for a colleague from their own phone.
  const user = await User.findById(req.user._id).select("+attendanceDevice");
  const device = sha256(`attendance:${deviceId}`);
  if (user.attendanceDevice && user.attendanceDevice !== device) throw forbidden("Your attendance is registered to another phone. Ask an administrator to reset it.");

  if (accuracy > MAX_ACCURACY_M) throw badRequest(`Your location is only accurate to ${Math.round(accuracy)} m. Turn on GPS (high accuracy) and try again near a window.`, "low_accuracy");
  const distance = Math.round(distanceM(shop, { lat, lng }));
  if (distance > settings.attendanceRadius) throw badRequest(`You are ${distance} m from the shop. Attendance can be marked only within ${settings.attendanceRadius} m of the shop.`, "outside_shop");

  const now = new Date();
  const { date, minutes } = storeNow(now);
  const point = { at: now, lat, lng, accuracy: Math.round(accuracy), distance };
  let row;
  if (kind === "in") {
    if (await Attendance.exists({ userId: user._id, date })) throw conflict("You have already checked in today.", "already_marked");
    let start = settings.openTime;
    // A groomer is late against their own start time; everyone else against opening time.
    if (user.groomerId) start = (await Groomer.findById(user.groomerId).select("workStart").lean())?.workStart ?? start;
    row = await Attendance.create({ userId: user._id, name: user.name, role: user.role, date, in: point, late: minutes > start + settings.attendanceGraceMinutes }).catch((e) => {
      if (e?.code === 11000) throw conflict("You have already checked in today.", "already_marked");
      throw e;
    });
  } else {
    row = await Attendance.findOneAndUpdate({ userId: user._id, date, "in.at": { $exists: true }, "out.at": { $exists: false } }, { $set: { out: point } }, { returnDocument: "after" });
    if (!row) throw conflict((await Attendance.exists({ userId: user._id, date })) ? "You have already checked out today." : "Check in first.", "bad_transition");
  }
  if (!user.attendanceDevice) {
    user.attendanceDevice = device;
    await user.save();
  }
  audit(req, "attendance", kind === "in" ? "check_in" : "check_out", `${user.name} checked ${kind} (${distance} m from shop)`, row.id);
  res.json({ today: dto.attendance(row) });
});

router.get("/attendance", can("attendance.manage"), validate({ query: range }), async (req, res) => {
  checkRange(req.valid.query, 92);
  const { from, to } = req.valid.query;
  const [rows, people] = await Promise.all([
    Attendance.find({ date: { $gte: from, $lte: to } }).sort({ date: -1, name: 1 }).limit(10_000).lean(),
    User.find({ role: { $nin: ["customer"] }, status: "active" }).select("+attendanceDevice name role grants revokes").lean(),
  ]);
  const staff = people
    .filter((u) => effectivePermissions(u).includes("attendance.own"))
    .map((u) => ({ id: String(u._id), name: u.name, role: u.role, deviceBound: Boolean(u.attendanceDevice) }))
    .sort((a, b) => a.name.localeCompare(b.name));
  res.json({ rows: rows.map(dto.attendance), staff });
});

router.post("/attendance/device-reset", can("attendance.manage"), writeLimit, validate({ body: z.strictObject({ userId: objectId }) }), async (req, res) => {
  const user = await User.findOneAndUpdate({ _id: req.valid.body.userId, role: { $ne: "customer" } }, { $unset: { attendanceDevice: 1 } });
  if (!user) throw notFound("Account not found.");
  audit(req, "attendance", "device_reset", `Attendance phone reset for ${user.name}`, user.id);
  res.json({ ok: true });
});

/* ---------- Pick & drop ---------- */

async function tripRows(bookings) {
  const [users, pets] = await Promise.all([
    User.find({ _id: { $in: bookings.map((b) => b.userId) } }).select("name phone").lean(),
    Pet.find({ _id: { $in: bookings.map((b) => b.petId) } }).lean(),
  ]);
  return {
    trips: bookings.map(dto.panelBooking),
    customers: users.map((u) => ({ id: String(u._id), name: u.name, phone: dto.formatPhone(u.phone) })),
    pets: pets.map(dto.panelPet),
  };
}

router.get("/pickdrop", can("pickdrop.manage"), validate({ query: range }), async (req, res) => {
  checkRange(req.valid.query, 92);
  const { from, to } = req.valid.query;
  const bookings = await Booking.find({ date: { $gte: from, $lte: to }, "pickDrop.stage": { $exists: true } }).sort({ date: 1, start: 1 }).limit(3000).lean();
  const people = await User.find({ role: { $ne: "customer" }, status: "active" }).select("name role grants revokes").lean();
  const staff = people.filter((u) => effectivePermissions(u).includes("pickdrop.own")).map((u) => ({ id: String(u._id), name: u.name, role: u.role }));
  res.json({ ...(await tripRows(bookings)), staff });
});

/** The signed-in driver's own trips. */
router.get("/trips", can("pickdrop.own"), async (req, res) => {
  const today = storeNow().date;
  const bookings = await Booking.find({ "pickDrop.staffId": req.user._id, date: { $gte: addDaysISO(today, -3), $lte: addDaysISO(today, 14) } }).sort({ date: 1, start: 1 }).limit(500).lean();
  res.json(await tripRows(bookings));
});

const assignBody = z.strictObject({ staffId: objectId, window: text(40).optional() });

router.post("/pickdrop/:id/assign", can("pickdrop.manage"), writeLimit, validate({ params: idParams, body: assignBody }), async (req, res) => {
  const booking = await assignTrip(req.valid.params.id, req.valid.body);
  audit(req, "pickdrop", "assign", `#${booking.bookingNo} trip → ${booking.pickDrop.staffName}`, booking.id);
  res.json({ booking: dto.panelBooking(booking) });
});

const stepBody = z.strictObject({ step: z.enum(["collected", "at_store", "out_for_drop", "delivered"]), code: z.string().regex(/^\d{6}$/).optional() });

router.post("/pickdrop/:id/step", can("pickdrop.own", "pickdrop.manage"), pickupOtpLimit, validate({ params: idParams, body: stepBody }), async (req, res) => {
  const { booking } = await stepTrip(req.valid.params.id, req.valid.body, req.user, has(req, "pickdrop.manage"));
  audit(req, "pickdrop", req.valid.body.step, `#${booking.bookingNo} trip: ${req.valid.body.step}`, booking.id);
  res.json({ booking: dto.panelBooking(booking) });
});

router.post("/pickdrop/:id/collect-code", can("pickdrop.manage"), writeLimit, validate({ params: idParams }), async (req, res) => {
  const booking = await newCollectCode(req.valid.params.id);
  audit(req, "pickdrop", "collect_code", `New pickup code for #${booking.bookingNo}`, booking.id);
  res.json({ booking: dto.panelBooking(booking) });
});

/* ---------- Leads: enquiries and where customers heard about the store ---------- */

router.get("/enquiries", can("customers.manage"), async (_req, res) => {
  const rows = await Enquiry.find().sort({ createdAt: -1 }).limit(1000).lean();
  res.json({ enquiries: rows.map(dto.enquiry) });
});

const enquiryPatch = z.strictObject({ status: z.enum(["new", "contacted", "converted", "lost"]).optional(), notes: text(1000).optional(), source: text(40).optional(), sourceNote: text(120).optional() });

router.patch("/enquiries/:id", can("customers.manage"), writeLimit, validate({ params: idParams, body: enquiryPatch }), async (req, res) => {
  await checkLeadSource(req.valid.body.source);
  const patch = { ...req.valid.body, ...(req.valid.body.status ? { handled: req.valid.body.status !== "new" } : {}) };
  const row = await Enquiry.findByIdAndUpdate(req.valid.params.id, { $set: patch }, { returnDocument: "after" });
  if (!row) throw notFound("Enquiry not found.");
  audit(req, "customers", "enquiry", `Enquiry from ${row.name}: ${row.status}`, row.id);
  res.json({ enquiry: dto.enquiry(row) });
});

/** Turns an enquiry into a customer, or links it to the customer who already has that number. */
router.post("/enquiries/:id/convert", can("customers.manage"), writeLimit, validate({ params: idParams }), async (req, res) => {
  const row = await Enquiry.findById(req.valid.params.id);
  if (!row) throw notFound("Enquiry not found.");
  let user = await User.findOne({ phone: row.phone });
  if (user && user.role !== "customer") throw conflict("This number belongs to a staff account.");
  user ??= await User.create({ role: "customer", name: row.name, phone: row.phone, leadSource: row.source || undefined, leadNote: row.sourceNote || undefined });
  if (!user.leadSource && row.source) {
    user.leadSource = row.source;
    user.leadNote = row.sourceNote;
    await user.save();
  }
  row.status = "converted";
  row.handled = true;
  row.customerId = user._id;
  await row.save();
  audit(req, "customers", "convert", `Enquiry from ${row.name} → customer`, user.id);
  res.json({ enquiry: dto.enquiry(row), customer: dto.customer(user) });
});

/** New customers, enquiries, bookings and revenue per lead source, for the chosen period. */
router.get("/reports/leads", can("customers.manage", "reports.view"), validate({ query: range }), async (req, res) => {
  checkRange(req.valid.query, 366);
  const { from, to } = req.valid.query;
  const [customers, enquiries] = await Promise.all([
    User.find({ role: "customer", createdAt: { $gte: dayStart(from), $lte: dayEnd(to) } }).select("leadSource").lean(),
    Enquiry.find({ createdAt: { $gte: dayStart(from), $lte: dayEnd(to) } }).select("source status").lean(),
  ]);
  const ids = customers.map((c) => c._id);
  const [bookings, invoices] = await Promise.all([
    Booking.find({ userId: { $in: ids }, status: { $nin: ["cancelled"] } }).select("userId").lean(),
    Invoice.find({ userId: { $in: ids }, status: { $ne: "cancelled" } }).lean(),
  ]);
  const sourceOf = new Map(customers.map((c) => [String(c._id), c.leadSource || "unknown"]));
  const rows = new Map();
  const row = (k) => {
    if (!rows.has(k)) rows.set(k, { source: k, customers: 0, enquiries: 0, converted: 0, bookings: 0, revenue: 0 });
    return rows.get(k);
  };
  for (const c of customers) row(c.leadSource || "unknown").customers++;
  for (const e of enquiries) {
    const r = row(e.source || "unknown");
    r.enquiries++;
    if (e.status === "converted") r.converted++;
  }
  for (const b of bookings) row(sourceOf.get(String(b.userId))).bookings++;
  for (const i of invoices) row(sourceOf.get(String(i.userId))).revenue += billTotals(i).paid;
  res.json({ rows: [...rows.values()].map((r) => ({ ...r, revenue: Math.round(r.revenue) })) });
});

/* ---------- Login details by SMS, sent by the super admin ---------- */

router.post("/customers/login-sms", can("users.manage"), writeLimit, validate({ body: z.strictObject({ customerIds: z.array(objectId).min(1).max(100) }) }), async (req, res) => {
  const sms = await getSmsConfig();
  const live = textReady(sms);
  if (!live && env.isProd) throw new ApiError(503, "SMS isn't set up. Add the sender ID in Settings > SMS first.", "sms_not_configured");
  if (!sms.siteUrl) throw badRequest("Add the website link in Settings > SMS first.");
  const users = await User.find({ _id: { $in: req.valid.body.customerIds }, role: "customer" });
  const sent = [];
  const failed = [];
  for (const u of users) {
    if (!u.phone) {
      failed.push({ id: u.id, name: u.name, reason: "No mobile number" });
      continue;
    }
    const message = fillTemplate(sms.loginTemplate, { name: u.name.split(" ")[0], phone: u.phone, link: sms.siteUrl });
    try {
      if (live) await sendText(sms, u.phone, message);
      else if (!env.isTest) console.log(`[dev sms] to ${u.phone}: ${message}`);
      u.loginSmsAt = new Date();
      await u.save();
      sent.push(u.id);
    } catch (err) {
      logger.error({ err }, "login sms failed");
      failed.push({ id: u.id, name: u.name, reason: "SMS provider refused it" });
    }
  }
  audit(req, "customers", "login_sms", `Login details sent by SMS to ${sent.length} customer(s)${failed.length ? `, ${failed.length} failed` : ""}`);
  res.json({ sent: sent.length, failed, simulated: !live });
});

/* ---------- GST data for the CA: read-only, any period up to a year ---------- */

router.get("/gst", can("gst.view", "reports.view"), validate({ query: range }), async (req, res) => {
  checkRange(req.valid.query, 366);
  const { from, to } = req.valid.query;
  const [invoices, settings] = await Promise.all([Invoice.find({ date: { $gte: dayStart(from), $lte: dayEnd(to) } }).sort({ date: 1 }).limit(50_000).lean(), getSettings()]);
  res.json({ invoices: invoices.map(dto.panelInvoice), store: { name: settings.storeName, gstin: settings.gstin, address: settings.address, gstEnabled: settings.gstEnabled } });
});

export default router;
