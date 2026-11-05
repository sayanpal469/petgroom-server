import { Router } from "express";
import { env } from "../config/env.js";
import { z } from "zod";
import { createBooking, customerMayChange, moveBooking, setStatus } from "../lib/bookings.js";
import { placeOrder, setOrderStatus } from "../lib/commerce.js";
import { hmac, randomDigits, safeEqual } from "../lib/crypto.js";
import * as dto from "../lib/dto.js";
import { ApiError, badRequest, conflict, forbidden, notFound } from "../lib/errors.js";
import { logger } from "../lib/logger.js";
import { decodeImage, storePublicImage } from "../lib/media.js";
import { getSettings } from "../lib/misc.js";
import { bookingSlip, invoicePdf } from "../lib/pdf.js";
import { OTP_LENGTH, checkOtp, getSmsConfig, isDemoLogin, isDemoPhone, providerReady, sendOtp } from "../lib/sms.js";
import { endSession, optionalCustomer, requireCustomer, startSession } from "../middleware/auth.js";
import { otpIpLimit, otpPhoneLimit, otpVerifyLimit, uploadLimit, writeLimit } from "../middleware/rateLimit.js";
import { anyPhone, idParams, isoDate, minutes, objectId, text, validate } from "../middleware/validate.js";
import { Booking, Groomer, Invoice, Notification, Order, OtpChallenge, Pet, User } from "../models/index.js";

export const authRouter = Router();
export const meRouter = Router();

/* ---------- Mobile OTP login. The reply is the same for known and unknown numbers. ---------- */

const OTP_TTL = 5 * 60_000;

authRouter.post("/otp/request", otpIpLimit, validate({ body: z.strictObject({ phone: anyPhone }) }), otpPhoneLimit, async (req, res) => {
  const { phone } = req.valid.body;
  const sms = await getSmsConfig();
  if (isDemoPhone(sms, phone)) return res.json({ ok: true, resendAfter: 30 });
  if (!/^[6-9]/.test(phone)) throw badRequest("Enter a valid 10-digit mobile number", "invalid_input");

  const expiresAt = new Date(Date.now() + OTP_TTL);
  if (providerReady(sms)) {
    const sent = await sendOtp(sms, phone).catch((err) => {
      logger.error({ err }, "otp sms failed");
      throw new ApiError(503, "Couldn't send the OTP right now. Please try again shortly.", "sms_failed");
    });
    if (sent.verificationId) await OtpChallenge.updateOne({ phone }, { $set: { verificationId: sent.verificationId, attempts: 0, expiresAt }, $unset: { codeHash: 1 } }, { upsert: true });
    return res.json({ ok: true, resendAfter: 30 });
  }
  if (env.isProd) throw new ApiError(503, "Login by OTP isn't available yet. Please call the store.", "sms_not_configured");
  const code = randomDigits(OTP_LENGTH);
  await OtpChallenge.updateOne({ phone }, { $set: { codeHash: hmac(`${phone}:${code}`), attempts: 0, expiresAt }, $unset: { verificationId: 1 } }, { upsert: true });
  if (!env.isTest) console.log(`[dev sms] login OTP for ${phone}: ${code}`);
  res.json({ ok: true, resendAfter: 30 });
});

async function otpMatches(phone, code) {
  const sms = await getSmsConfig();
  if (isDemoLogin(sms, phone, code)) return true;
  const challenge = await OtpChallenge.findOneAndUpdate({ phone, expiresAt: { $gt: new Date() }, attempts: { $lt: 5 } }, { $inc: { attempts: 1 } }, { returnDocument: "after" }).lean();
  if (!challenge) return false;
  if (challenge.verificationId) return checkOtp(sms, phone, challenge.verificationId, code).catch((err) => {
    logger.error({ err }, "otp check failed");
    return false;
  });
  return safeEqual(challenge.codeHash, hmac(`${phone}:${code}`));
}

authRouter.post("/otp/verify", otpVerifyLimit, validate({ body: z.strictObject({ phone: anyPhone, code: z.string().regex(/^\d{4,6}$/) }) }), async (req, res) => {
  const { phone, code } = req.valid.body;
  if (!(await otpMatches(phone, code))) throw badRequest("That code didn't match. Please try again.", "wrong_otp");
  await OtpChallenge.deleteOne({ phone });

  let user = await User.findOne({ phone });
  if (user && (user.role !== "customer" || user.status !== "active")) throw badRequest("That code didn't match. Please try again.", "wrong_otp");
  const isNew = !user;
  user ??= await User.create({ role: "customer", name: "New Customer", phone });
  await startSession(req, res, user, "customer");
  res.json({ user: dto.customerSelf(user), isNew });
});

authRouter.get("/me", optionalCustomer, (req, res) => {
  res.json({ user: req.user?.role === "customer" ? dto.customerSelf(req.user) : null });
});

authRouter.post("/logout", async (req, res) => {
  await endSession(req, res, "customer");
  res.json({ ok: true });
});

/* ---------- Everything below acts only on the logged-in customer's own records. ---------- */

meRouter.use(requireCustomer);

meRouter.get("/bootstrap", async (req, res) => {
  const userId = req.user._id;
  const [pets, bookings, orders, invoices, notifications] = await Promise.all([
    Pet.find({ userId, active: true }).sort({ createdAt: 1 }).lean(),
    Booking.find({ userId }).sort({ date: -1, start: -1 }).limit(100).lean(),
    Order.find({ userId }).sort({ createdAt: -1 }).limit(100).lean(),
    Invoice.find({ userId }).sort({ date: -1 }).limit(100).lean(),
    Notification.find({ userId }).sort({ createdAt: -1 }).limit(50).lean(),
  ]);
  res.json({
    user: dto.customerSelf(req.user),
    pets: pets.map(dto.pet),
    bookings: bookings.map(dto.customerBooking),
    orders: orders.map(dto.customerOrder),
    invoices: invoices.map(dto.customerInvoice),
    notifications: notifications.map(dto.notification),
  });
});

const profile = z.strictObject({ name: text(80).min(2).optional(), email: z.union([z.email().max(120), z.literal("")]).optional(), prefs: z.record(z.string().max(40), z.boolean()).optional() });

meRouter.patch("/profile", writeLimit, validate({ body: profile }), async (req, res) => {
  const { name, email, prefs } = req.valid.body;
  if (name) req.user.name = name;
  if (email !== undefined) req.user.email = email ? email : undefined;
  if (prefs) req.user.prefs = { ...req.user.prefs, ...prefs };
  await req.user.save();
  res.json({ user: dto.customerSelf(req.user) });
});

const addressBody = z.strictObject({
  label: text(40).min(1),
  kind: z.enum(["home", "office", "other"]),
  line1: text(120).min(3),
  line2: text(120).optional().default(""),
  city: text(60).min(2),
  pincode: z.string().regex(/^\d{6}$/, "Enter a 6-digit pincode"),
  state: text(60).min(2),
  phone: text(20).min(10),
  isDefault: z.boolean().optional(),
});

function setDefault(user, id) {
  user.addresses.forEach((a) => {
    a.isDefault = String(a._id) === String(id);
  });
}

meRouter.post("/addresses", writeLimit, validate({ body: addressBody }), async (req, res) => {
  if (req.user.addresses.length >= 20) throw badRequest("You can save up to 20 addresses.");
  req.user.addresses.push(req.valid.body);
  const created = req.user.addresses.at(-1);
  if (req.valid.body.isDefault || req.user.addresses.length === 1) setDefault(req.user, created._id);
  await req.user.save();
  res.status(201).json({ addresses: req.user.addresses.map(dto.address), id: String(created._id) });
});

meRouter.put("/addresses/:id", writeLimit, validate({ params: idParams, body: addressBody }), async (req, res) => {
  const a = req.user.addresses.id(req.valid.params.id);
  if (!a) throw notFound();
  a.set(req.valid.body);
  if (req.valid.body.isDefault) setDefault(req.user, a._id);
  await req.user.save();
  res.json({ addresses: req.user.addresses.map(dto.address) });
});

meRouter.delete("/addresses/:id", writeLimit, validate({ params: idParams }), async (req, res) => {
  const a = req.user.addresses.id(req.valid.params.id);
  if (!a) throw notFound();
  const wasDefault = a.isDefault;
  a.deleteOne();
  if (wasDefault && req.user.addresses[0]) req.user.addresses[0].isDefault = true;
  await req.user.save();
  res.json({ addresses: req.user.addresses.map(dto.address) });
});

const petBody = z.strictObject({
  name: text(40).min(1),
  type: z.enum(["dog", "cat"]),
  breed: text(60).optional().default(""),
  size: z.enum(["small", "medium", "large"]),
  age: text(20).optional().default(""),
  vaccinated: z.boolean().optional().default(false),
  notes: text(300).optional(),
  photoData: z.string().max(12_000_000).optional(),
});

async function petFields(body) {
  const { photoData, ...fields } = body;
  if (photoData) fields.photo = await storePublicImage(decodeImage(photoData), "pet.jpg", 900);
  return fields;
}

meRouter.post("/pets", uploadLimit, validate({ body: petBody }), async (req, res) => {
  if ((await Pet.countDocuments({ userId: req.user._id, active: true })) >= 20) throw badRequest("You can add up to 20 pets.");
  const pet = await Pet.create({ ...(await petFields(req.valid.body)), userId: req.user._id });
  res.status(201).json({ pet: dto.pet(pet) });
});

meRouter.put("/pets/:id", uploadLimit, validate({ params: idParams, body: petBody }), async (req, res) => {
  const pet = await Pet.findOneAndUpdate({ _id: req.valid.params.id, userId: req.user._id, active: true }, { $set: await petFields(req.valid.body) }, { returnDocument: "after" });
  if (!pet) throw notFound("Pet not found.");
  res.json({ pet: dto.pet(pet) });
});

/** Soft delete: past bookings and clinic records still need the pet. */
meRouter.delete("/pets/:id", writeLimit, validate({ params: idParams }), async (req, res) => {
  const pet = await Pet.findOneAndUpdate({ _id: req.valid.params.id, userId: req.user._id }, { $set: { active: false } });
  if (!pet) throw notFound("Pet not found.");
  res.json({ ok: true });
});

/* ---------- Bookings ---------- */

const ownBooking = async (req, withOtp = false) => {
  const q = Booking.findOne({ _id: req.valid.params.id, userId: req.user._id });
  const b = await (withOtp ? q.select("+pickup.otpSealed") : q);
  if (!b) throw notFound("Booking not found.");
  return b;
};

const newBooking = z.strictObject({ petId: objectId, serviceIds: z.array(objectId).min(1).max(10), groomerId: objectId.nullish(), date: isoDate, start: minutes, notes: text(500).optional() });

meRouter.post("/bookings", writeLimit, validate({ body: newBooking }), async (req, res) => {
  if (req.user.blocked) throw forbidden("Online booking is unavailable on your account. Please call the store.");
  const booking = await createBooking({ ...req.valid.body, userId: req.user._id, source: "online" });
  res.status(201).json({ booking: dto.customerBooking(booking) });
});

meRouter.get("/bookings/:id", validate({ params: idParams }), async (req, res) => {
  res.json({ booking: dto.customerBookingDetail(await ownBooking(req, true)) });
});

meRouter.post("/bookings/:id/cancel", writeLimit, validate({ params: idParams, body: z.strictObject({ reason: text(200).optional() }) }), async (req, res) => {
  const booking = await ownBooking(req);
  await customerMayChange(booking);
  await setStatus(booking, "cancelled", { reason: req.valid.body.reason ?? "Cancelled by customer", actor: req.user.name });
  res.json({ booking: dto.customerBooking(booking) });
});

meRouter.post("/bookings/:id/reschedule", writeLimit, validate({ params: idParams, body: z.strictObject({ date: isoDate, start: minutes }) }), async (req, res) => {
  const booking = await ownBooking(req);
  await customerMayChange(booking);
  await moveBooking(booking, req.valid.body);
  res.json({ booking: dto.customerBooking(booking) });
});

meRouter.post("/bookings/:id/rate", writeLimit, validate({ params: idParams, body: z.strictObject({ rating: z.number().int().min(1).max(5) }) }), async (req, res) => {
  const booking = await ownBooking(req);
  if (!["completed", "ready_for_pickup", "picked_up"].includes(booking.status)) throw conflict("You can rate after the service.");
  booking.rating = req.valid.body.rating;
  await booking.save();
  res.json({ booking: dto.customerBooking(booking) });
});

meRouter.get("/bookings/:id/slip", validate({ params: idParams }), async (req, res) => {
  const booking = await ownBooking(req);
  const [pet, groomer, settings] = await Promise.all([Pet.findById(booking.petId).lean(), Groomer.findById(booking.groomerId).lean(), getSettings()]);
  const pdf = await bookingSlip({ booking, customer: req.user, pet, groomer, settings });
  res.json({ filename: `booking-${booking.bookingNo}.pdf`, base64: pdf.toString("base64") });
});

/* ---------- Orders ---------- */

const newOrder = z.strictObject({
  items: z.array(z.strictObject({ productId: objectId, variantId: text(40).min(1), qty: z.number().int().min(1).max(20) })).min(1).max(30),
  fulfilment: z.enum(["delivery", "pickup", "next_grooming"]),
  payment: z.enum(["COD", "PAY_AT_STORE"]),
  addressId: objectId.optional(),
  couponCode: text(30).optional(),
});

meRouter.post("/orders", writeLimit, validate({ body: newOrder }), async (req, res) => {
  if (req.user.blocked) throw forbidden("Online orders are unavailable on your account. Please call the store.");
  const order = await placeOrder(req.user, req.valid.body);
  res.status(201).json({ order: dto.customerOrder(order) });
});

meRouter.post("/orders/:id/cancel", writeLimit, validate({ params: idParams }), async (req, res) => {
  const order = await Order.findOne({ _id: req.valid.params.id, userId: req.user._id });
  if (!order) throw notFound("Order not found.");
  if (order.status !== "placed") throw conflict("This order is already being prepared. Please call the store.");
  await setOrderStatus(order, "cancelled", { reason: "Cancelled by customer", by: req.user._id });
  res.json({ order: dto.customerOrder(order) });
});

/* ---------- Bills ---------- */

meRouter.get("/invoices/:id/pdf", validate({ params: idParams }), async (req, res) => {
  const invoice = await Invoice.findOne({ _id: req.valid.params.id, userId: req.user._id }).lean();
  if (!invoice) throw notFound("Bill not found.");
  const pdf = await invoicePdf({ invoice, settings: await getSettings() });
  res.json({ filename: `bill-${invoice.invoiceNo}.pdf`, base64: pdf.toString("base64") });
});

/* ---------- Notifications ---------- */

meRouter.post("/notifications/read-all", async (req, res) => {
  await Notification.updateMany({ userId: req.user._id, unread: true }, { $set: { unread: false } });
  res.json({ ok: true });
});

meRouter.post("/notifications/:id/read", validate({ params: idParams }), async (req, res) => {
  await Notification.updateOne({ _id: req.valid.params.id, userId: req.user._id }, { $set: { unread: false } });
  res.json({ ok: true });
});

