import mongoose from "mongoose";
import { Router } from "express";
import { z } from "zod";
import { createBooking, moveBooking, notifyStaff, regeneratePickup, setStatus, verifyPickup } from "../lib/bookings.js";
import { addPayment, cancelInvoice, createInvoice, setOrderStatus } from "../lib/commerce.js";
import * as dto from "../lib/dto.js";
import { badRequest, conflict, forbidden, notFound } from "../lib/errors.js";
import { decodeImage, storePublicImage } from "../lib/media.js";
import { addDaysISO, audit, getSettings, storeNow } from "../lib/misc.js";
import { bookingSlip, invoicePdf } from "../lib/pdf.js";
import { workload } from "../lib/slots.js";
import { can } from "../middleware/auth.js";
import { pickupOtpLimit, uploadLimit, writeLimit } from "../middleware/rateLimit.js";
import { idParams, isoDate, minutes, objectId, phone10, text, validate } from "../middleware/validate.js";
import { BOOKING_STATUS, Booking, Coupon, Groomer, Invoice, Order, Package, Pet, Product, Service, StockLog, User } from "../models/index.js";

const router = Router();
const has = (req, ...p) => p.some((x) => req.permissions.has(x));

/* ---------- Bootstrap: each account receives only the data its modules use. ---------- */

router.get("/bootstrap", async (req, res) => {
  const today = storeNow().date;
  const out = { settings: null, services: [], packages: [], groomers: [], products: [], customers: [], pets: [], bookings: [], orders: [], invoices: [], coupons: [], stockLogs: [] };
  const front = has(req, "bookings.manage", "orders.manage", "billing.manage", "customers.manage");
  const jobs = [];
  const take = (key, query, map) => jobs.push(query.then((rows) => (out[key] = rows.map(map))));

  if (front || has(req, "catalog.manage", "inventory.manage", "schedule.manage", "settings.manage", "reports.view", "dashboard.view", "staff.assign")) {
    const { templates: _t, ...settings } = await getSettings();
    out.settings = has(req, "settings.manage") ? await getSettings() : settings;
    take("services", Service.find().sort({ order: 1 }).lean(), dto.panelService);
    take("packages", Package.find().sort({ price: 1 }).lean(), dto.pkg);
    take("groomers", Groomer.find().lean(), dto.panelGroomer);
  }
  if (front || has(req, "catalog.manage", "inventory.manage", "dashboard.view")) take("products", Product.find().limit(3000).lean(), dto.panelProduct);
  if (has(req, "inventory.manage")) take("stockLogs", StockLog.find().sort({ at: -1 }).limit(500).lean(), dto.stockLog);
  if (front || has(req, "dashboard.view")) {
    const since = addDaysISO(today, -45);
    const until = addDaysISO(today, 60);
    const sinceDate = new Date(`${since}T00:00:00+05:30`);
    take("customers", User.find({ role: "customer" }).sort({ createdAt: -1 }).limit(3000).lean(), dto.customer);
    take("pets", Pet.find({ active: true }).limit(6000).lean(), dto.panelPet);
    take("bookings", Booking.find({ date: { $gte: since, $lte: until } }).limit(5000).lean(), dto.panelBooking);
    take("orders", Order.find({ createdAt: { $gte: sinceDate } }).sort({ createdAt: -1 }).limit(3000).lean(), dto.panelOrder);
    take("invoices", Invoice.find({ date: { $gte: sinceDate } }).sort({ date: -1 }).limit(5000).lean(), dto.panelInvoice);
  }
  if (has(req, "billing.manage", "catalog.manage")) take("coupons", Coupon.find().lean(), dto.coupon);
  await Promise.all(jobs);
  res.json(out);
});

/* ---------- Bookings ---------- */

const ownedBooking = async (req) => {
  const b = await Booking.findById(req.valid.params.id);
  if (!b) throw notFound("Booking not found.");
  return b;
};

const walkin = z.strictObject({ customerId: objectId, petId: objectId, serviceIds: z.array(objectId).min(1).max(10), groomerId: objectId.nullish(), date: isoDate, start: minutes, notes: text(500).optional(), source: z.enum(["phone", "walkin"]) });

router.post("/bookings", can("bookings.manage"), writeLimit, validate({ body: walkin }), async (req, res) => {
  const { customerId, ...rest } = req.valid.body;
  const booking = await createBooking({ ...rest, userId: customerId });
  audit(req, "bookings", "create", `Added booking #${booking.bookingNo}`, booking.id);
  res.status(201).json({ booking: dto.panelBooking(booking) });
});

router.post("/bookings/:id/status", can("bookings.manage"), writeLimit, validate({ params: idParams, body: z.strictObject({ status: z.enum(BOOKING_STATUS), reason: text(200).optional() }) }), async (req, res) => {
  const booking = await ownedBooking(req);
  await setStatus(booking, req.valid.body.status, { reason: req.valid.body.reason, actor: req.user.name });
  audit(req, "bookings", "status", `#${booking.bookingNo} → ${booking.status}`, booking.id);
  res.json({ booking: dto.panelBooking(booking) });
});

const moveBody = z.strictObject({ date: isoDate.optional(), start: minutes.optional(), groomerId: objectId.optional() });

router.post("/bookings/:id/move", can("bookings.manage", "staff.assign"), writeLimit, validate({ params: idParams, body: moveBody }), async (req, res) => {
  const booking = await ownedBooking(req);
  if (["picked_up", "cancelled", "no_show"].includes(booking.status)) throw conflict("This booking is closed.");
  await moveBooking(booking, req.valid.body);
  audit(req, "bookings", "move", `#${booking.bookingNo} moved / reassigned`, booking.id);
  res.json({ booking: dto.panelBooking(booking) });
});

router.post("/bookings/:id/pickup/verify", can("bookings.manage"), pickupOtpLimit, validate({ params: idParams, body: z.strictObject({ code: z.string().regex(/^\d{6}$/) }) }), async (req, res) => {
  const booking = await verifyPickup(req.valid.params.id, req.valid.body.code, req.user);
  audit(req, "bookings", "pickup", `Pickup verified for #${booking.bookingNo}`, booking.id);
  res.json({ booking: dto.panelBooking(booking) });
});

router.post("/bookings/:id/pickup/regenerate", can("bookings.manage"), writeLimit, validate({ params: idParams }), async (req, res) => {
  const booking = await regeneratePickup(req.valid.params.id);
  audit(req, "bookings", "pickup_otp", `New pickup OTP for #${booking.bookingNo}`, booking.id);
  res.json({ booking: dto.panelBooking(booking) });
});

const photoBody = z.strictObject({ kind: z.enum(["before", "after"]), image: z.string().max(12_000_000) });

router.post("/bookings/:id/photos", can("bookings.manage", "work.own"), uploadLimit, validate({ params: idParams, body: photoBody }), async (req, res) => {
  const booking = await ownedBooking(req);
  if (!has(req, "bookings.manage") && String(booking.groomerId) !== String(req.user.groomerId)) throw forbidden();
  const url = await storePublicImage(decodeImage(req.valid.body.image), `${req.valid.body.kind}.jpg`);
  booking.photos ??= {};
  booking.photos[req.valid.body.kind] = url;
  await booking.save();
  res.json({ booking: dto.panelBooking(booking) });
});

router.get("/bookings/:id/slip", can("bookings.manage", "work.own"), validate({ params: idParams }), async (req, res) => {
  const booking = await ownedBooking(req);
  if (!has(req, "bookings.manage") && String(booking.groomerId) !== String(req.user.groomerId)) throw forbidden();
  const [customer, pet, groomer, settings] = await Promise.all([User.findById(booking.userId).lean(), Pet.findById(booking.petId).lean(), Groomer.findById(booking.groomerId).lean(), getSettings()]);
  const pdf = await bookingSlip({ booking, customer, pet, groomer, settings });
  res.json({ filename: `booking-${booking.bookingNo}.pdf`, base64: pdf.toString("base64") });
});

router.get("/workload", can("staff.assign", "bookings.manage"), validate({ query: z.strictObject({ date: isoDate }) }), async (req, res) => {
  res.json({ workload: await workload(req.valid.query.date) });
});

/* ---------- Staff portal: only the signed-in groomer's own appointments. ---------- */

const STAFF_STEPS = ["checked_in", "grooming_started", "in_progress", "completed", "ready_for_pickup"];

const myBooking = async (req) => {
  if (!req.user.groomerId) throw forbidden("Your account isn't linked to a groomer yet. Ask an administrator.");
  const b = await Booking.findOne({ _id: req.valid.params.id, groomerId: req.user.groomerId });
  if (!b) throw notFound("Appointment not found.");
  return b;
};

router.get("/work", can("work.own"), async (req, res) => {
  if (!req.user.groomerId) return res.json({ appointments: [], customers: [], pets: [] });
  const today = storeNow().date;
  const bookings = await Booking.find({ groomerId: req.user.groomerId, date: { $gte: addDaysISO(today, -14), $lte: addDaysISO(today, 30) } }).sort({ date: 1, start: 1 }).limit(500).lean();
  const [users, pets] = await Promise.all([
    User.find({ _id: { $in: bookings.map((b) => b.userId) } }).select("name phone").lean(),
    Pet.find({ _id: { $in: bookings.map((b) => b.petId) } }).lean(),
  ]);
  res.json({
    appointments: bookings.map(dto.panelBooking),
    customers: users.map((u) => ({ id: String(u._id), name: u.name, phone: dto.formatPhone(u.phone) })),
    pets: pets.map(dto.panelPet),
  });
});

router.post("/work/:id/ack", can("work.own"), writeLimit, validate({ params: idParams }), async (req, res) => {
  const booking = await myBooking(req);
  if (!booking.acknowledgedAt) booking.acknowledgedAt = new Date();
  if (booking.status === "confirmed") await setStatus(booking, "scheduled", { actor: req.user.name });
  else await booking.save();
  audit(req, "work", "acknowledge", `${req.user.name} acknowledged #${booking.bookingNo}`, booking.id);
  res.json({ booking: dto.panelBooking(booking) });
});

router.post("/work/:id/status", can("work.own"), writeLimit, validate({ params: idParams, body: z.strictObject({ status: z.enum(STAFF_STEPS) }) }), async (req, res) => {
  const booking = await myBooking(req);
  await setStatus(booking, req.valid.body.status, { actor: req.user.name });
  audit(req, "work", "status", `#${booking.bookingNo} → ${booking.status}`, booking.id);
  res.json({ booking: dto.panelBooking(booking) });
});

router.post("/work/:id/pickup", can("work.own"), pickupOtpLimit, validate({ params: idParams, body: z.strictObject({ code: z.string().regex(/^\d{6}$/) }) }), async (req, res) => {
  await myBooking(req);
  const booking = await verifyPickup(req.valid.params.id, req.valid.body.code, req.user);
  audit(req, "work", "pickup", `Pickup verified for #${booking.bookingNo}`, booking.id);
  res.json({ booking: dto.panelBooking(booking) });
});

/* ---------- Orders ---------- */

const orderStatus = z.strictObject({ status: z.enum(["confirmed", "packed", "out_for_delivery", "ready_for_pickup", "delivered", "cancelled"]), reason: text(200).optional() });

router.post("/orders/:id/status", can("orders.manage"), writeLimit, validate({ params: idParams, body: orderStatus }), async (req, res) => {
  const order = await Order.findById(req.valid.params.id);
  if (!order) throw notFound("Order not found.");
  await setOrderStatus(order, req.valid.body.status, { reason: req.valid.body.reason, by: req.user._id });
  audit(req, "orders", "status", `#${order.orderNo} → ${order.status}`, order.id);
  res.json({ order: dto.panelOrder(order) });
});

/* ---------- Billing ---------- */

const billItem = z.strictObject({
  key: text(60),
  kind: z.enum(["service", "product", "charge"]),
  refId: objectId.optional(),
  variantId: text(40).optional(),
  name: text(160).min(1),
  qty: z.number().int().min(1).max(999),
  price: z.number().min(0).max(1e7),
  gstRate: z.number().min(0).max(50),
  code: text(30).optional().default(""),
});

const paymentBody = z.strictObject({ mode: z.enum(["Cash", "UPI", "Card"]), amount: z.number().positive().max(1e7), reference: text(80).optional() });

const invoiceBody = z.strictObject({
  customerId: objectId.nullish(),
  customerName: text(80).min(1),
  customerPhone: text(20),
  petName: text(120).optional(),
  source: z.strictObject({ type: z.enum(["booking", "order", "walkin"]), refId: objectId.optional() }),
  items: z.array(billItem).min(1).max(100),
  discountPercent: z.number().min(0).max(100).optional(),
  discountFlat: z.number().min(0).max(1e7).optional(),
  discountLabel: text(80).optional(),
  couponId: objectId.optional(),
  payments: z.array(paymentBody).max(6),
});

router.post("/invoices", can("billing.manage"), writeLimit, validate({ body: invoiceBody }), async (req, res) => {
  const draft = { ...req.valid.body, _id: new mongoose.Types.ObjectId() };
  if (draft.source.type !== "walkin" && !draft.source.refId) throw badRequest("Bill source is missing.");
  const invoice = await createInvoice(draft, req.user);
  audit(req, "billing", "create", `Bill #${invoice.invoiceNo} created`, invoice.id);
  res.status(201).json({ invoice: dto.panelInvoice(invoice) });
});

router.post("/invoices/:id/payments", can("billing.manage"), writeLimit, validate({ params: idParams, body: paymentBody }), async (req, res) => {
  const invoice = await addPayment(req.valid.params.id, req.valid.body);
  audit(req, "billing", "payment", `₹${req.valid.body.amount} on #${invoice.invoiceNo}`, invoice.id);
  res.json({ invoice: dto.panelInvoice(invoice) });
});

router.post("/invoices/:id/cancel", can("billing.manage"), writeLimit, validate({ params: idParams, body: z.strictObject({ reason: text(200).min(3) }) }), async (req, res) => {
  const invoice = await cancelInvoice(req.valid.params.id, req.valid.body.reason, req.user);
  audit(req, "billing", "cancel", `Bill #${invoice.invoiceNo} cancelled: ${req.valid.body.reason}`, invoice.id);
  res.json({ invoice: dto.panelInvoice(invoice) });
});

router.get("/invoices/:id/pdf", can("billing.manage"), validate({ params: idParams }), async (req, res) => {
  const invoice = await Invoice.findById(req.valid.params.id).lean();
  if (!invoice) throw notFound("Bill not found.");
  const pdf = await invoicePdf({ invoice, settings: await getSettings() });
  res.json({ filename: `bill-${invoice.invoiceNo}.pdf`, base64: pdf.toString("base64") });
});

/* ---------- Customers and pets ---------- */

const customerBody = z.strictObject({ name: text(80).min(2), phone: phone10, email: z.union([z.email().max(120), z.literal("")]).optional(), notes: text(1000).optional(), blocked: z.boolean().optional(), noShowCount: z.literal(0).optional() });

router.post("/customers", can("customers.manage", "bookings.manage", "billing.manage"), writeLimit, validate({ body: customerBody }), async (req, res) => {
  const { email, ...rest } = req.valid.body;
  if (await User.exists({ phone: rest.phone })) throw conflict("A customer with this number already exists.", "phone_taken");
  const user = await User.create({ ...rest, ...(email ? { email } : {}), role: "customer" });
  audit(req, "customers", "create", `Added customer ${user.name}`, user.id);
  res.status(201).json({ customer: dto.customer(user) });
});

router.put("/customers/:id", can("customers.manage"), writeLimit, validate({ params: idParams, body: customerBody.partial() }), async (req, res) => {
  const user = await User.findOne({ _id: req.valid.params.id, role: "customer" });
  if (!user) throw notFound("Customer not found.");
  const { email, ...rest } = req.valid.body;
  user.set(rest);
  if (email !== undefined) user.email = email || undefined;
  await user.save();
  audit(req, "customers", "update", `Updated customer ${user.name}`, user.id);
  res.json({ customer: dto.customer(user) });
});

/** Everything about one customer, beyond the rolling window in the bootstrap. */
router.get("/customers/:id/history", can("customers.manage"), validate({ params: idParams }), async (req, res) => {
  const userId = req.valid.params.id;
  const [bookings, orders, invoices] = await Promise.all([
    Booking.find({ userId }).sort({ date: -1 }).limit(500).lean(),
    Order.find({ userId }).sort({ createdAt: -1 }).limit(500).lean(),
    Invoice.find({ userId }).sort({ date: -1 }).limit(500).lean(),
  ]);
  res.json({ bookings: bookings.map(dto.panelBooking), orders: orders.map(dto.panelOrder), invoices: invoices.map(dto.panelInvoice) });
});

const petBody = z.strictObject({ customerId: objectId, name: text(40).min(1), type: z.enum(["dog", "cat"]), breed: text(60).optional().default(""), size: z.enum(["small", "medium", "large"]), age: text(20).optional().default(""), vaccinated: z.boolean().optional(), notes: text(300).optional(), photo: text(200).optional() });

router.post("/pets", can("customers.manage", "bookings.manage"), writeLimit, validate({ body: petBody }), async (req, res) => {
  const { customerId, ...rest } = req.valid.body;
  if (!(await User.exists({ _id: customerId, role: "customer" }))) throw notFound("Customer not found.");
  const pet = await Pet.create({ ...rest, userId: customerId });
  res.status(201).json({ pet: dto.panelPet(pet) });
});

router.put("/pets/:id", can("customers.manage"), writeLimit, validate({ params: idParams, body: petBody }), async (req, res) => {
  const { customerId: _c, ...rest } = req.valid.body;
  const pet = await Pet.findByIdAndUpdate(req.valid.params.id, { $set: rest }, { returnDocument: "after" });
  if (!pet) throw notFound("Pet not found.");
  res.json({ pet: dto.panelPet(pet) });
});

export default router;
