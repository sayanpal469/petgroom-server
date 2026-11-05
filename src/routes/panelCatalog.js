import { Router } from "express";
import { z } from "zod";
import { withTxn } from "../config/db.js";
import * as dto from "../lib/dto.js";
import { badRequest, conflict, notFound } from "../lib/errors.js";
import { decodeImage, storePublicImage } from "../lib/media.js";
import { audit, nextSeq, saveSettings } from "../lib/misc.js";
import { getSmsConfig, providerReady, saveSmsConfig, smsView, testConnection } from "../lib/sms.js";
import { can } from "../middleware/auth.js";
import { uploadLimit, writeLimit } from "../middleware/rateLimit.js";
import { idParams, isoDate, minutes, text, validate } from "../middleware/validate.js";
import { Coupon, Groomer, Package, Product, Service, SlotBlock, StockLog } from "../models/index.js";
import { clearPublicCache } from "./public.js";

const router = Router();
const slugify = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 70) || "item";
const sized = z.strictObject({ small: z.number().min(0).max(1e6), medium: z.number().min(0).max(1e6), large: z.number().min(0).max(1e6) });
const imageRef = z.string().max(300).regex(/^\/[\w\-./]*$/, "Invalid image path");

/* ---------- Upload for catalog images (product, service, gallery). Returns the public URL. ---------- */

router.post("/images", can("catalog.manage", "inventory.manage"), uploadLimit, validate({ body: z.strictObject({ image: z.string().max(12_000_000) }) }), async (req, res) => {
  res.status(201).json({ url: await storePublicImage(decodeImage(req.valid.body.image), "catalog.jpg") });
});

/* ---------- Services and packages ---------- */

const serviceBody = z.strictObject({ name: text(100).min(2), short: text(300).optional(), category: z.enum(["bath", "styling", "hygiene", "package"]), icon: text(40).optional(), image: imageRef.optional(), prices: sized, durations: sized, popular: z.boolean().optional(), forCats: z.boolean().optional(), gstRate: z.number().min(0).max(50), sac: text(20), active: z.boolean() });

router.post("/services", can("catalog.manage"), writeLimit, validate({ body: serviceBody }), async (req, res) => {
  const service = await Service.create({ ...req.valid.body, slug: `${slugify(req.valid.body.name)}-${Date.now().toString(36)}` });
  clearPublicCache();
  audit(req, "catalog", "create", `Added service ${service.name}`, service.id);
  res.status(201).json({ service: dto.panelService(service) });
});

router.put("/services/:id", can("catalog.manage"), writeLimit, validate({ params: idParams, body: serviceBody }), async (req, res) => {
  const service = await Service.findByIdAndUpdate(req.valid.params.id, { $set: req.valid.body }, { returnDocument: "after" });
  if (!service) throw notFound();
  clearPublicCache();
  audit(req, "catalog", "update", `Updated service ${service.name}`, service.id);
  res.json({ service: dto.panelService(service) });
});

const packageBody = z.strictObject({ name: text(100).min(2), description: text(300).optional(), visits: z.number().int().min(1).max(100), price: z.number().min(0).max(1e6), worth: z.number().min(0).max(1e6), validityDays: z.number().int().min(1).max(3650), includes: z.array(text(120)).max(20), highlight: z.boolean().optional() });

router.post("/packages", can("catalog.manage"), writeLimit, validate({ body: packageBody }), async (req, res) => {
  const pack = await Package.create(req.valid.body);
  clearPublicCache();
  res.status(201).json({ package: dto.pkg(pack) });
});

router.put("/packages/:id", can("catalog.manage"), writeLimit, validate({ params: idParams, body: packageBody }), async (req, res) => {
  const pack = await Package.findByIdAndUpdate(req.valid.params.id, { $set: req.valid.body }, { returnDocument: "after" });
  if (!pack) throw notFound();
  clearPublicCache();
  res.json({ package: dto.pkg(pack) });
});

/* ---------- Products, barcodes and stock ---------- */

const variantBody = z.strictObject({ id: text(40).min(1), label: text(60).min(1), price: z.number().min(0).max(1e7), mrp: z.number().min(0).max(1e7), barcode: z.string().regex(/^[0-9A-Za-z-]{4,32}$/).or(z.literal("")).optional() });

const productBody = z.strictObject({
  name: text(140).min(2),
  category: z.enum(["food", "shampoo", "treats", "accessories", "toys"]),
  petType: z.enum(["dog", "cat", "both"]),
  image: imageRef,
  gallery: z.array(imageRef).max(8).optional(),
  variants: z.array(variantBody).min(1).max(20),
  description: text(3000).optional(),
  usage: text(2000).optional(),
  highlights: z.array(text(160)).max(12).optional(),
  tag: text(30).optional(),
  gstRate: z.number().min(0).max(50),
  hsn: text(20).optional(),
  lowStockLevel: z.number().int().min(0).max(100000),
  active: z.boolean(),
  stock: z.number().int().min(0).max(1e6).optional(),
});

/** EAN-13 check digit, so generated codes scan on any retail scanner. */
export function ean13(prefix12) {
  const sum = [...prefix12].reduce((s, d, i) => s + Number(d) * (i % 2 ? 3 : 1), 0);
  return `${prefix12}${(10 - (sum % 10)) % 10}`;
}

export async function newBarcode() {
  const seq = await nextSeq("barcode", 100000);
  return ean13(`890${String(seq).padStart(9, "0")}`);
}

async function withBarcodes(variants) {
  const out = [];
  for (const v of variants) out.push({ ...v, barcode: v.barcode || (await newBarcode()) });
  return out;
}

const dupBarcode = (e) => {
  if (e?.code === 11000) throw conflict("That barcode is already used by another product.", "barcode_taken");
  throw e;
};

router.post("/products", can("catalog.manage", "inventory.manage"), writeLimit, validate({ body: productBody }), async (req, res) => {
  const { stock = 0, ...body } = req.valid.body;
  const product = await Product.create({ ...body, stock, variants: await withBarcodes(body.variants), gallery: body.gallery?.length ? body.gallery : [body.image], slug: `${slugify(body.name)}-${Date.now().toString(36)}` }).catch(dupBarcode);
  if (stock) await StockLog.create({ productId: product._id, change: stock, reason: "stock_in", note: "Opening stock", by: req.user._id });
  clearPublicCache();
  audit(req, "catalog", "create", `Added product ${product.name}`, product.id);
  res.status(201).json({ product: dto.panelProduct(product) });
});

router.put("/products/:id", can("catalog.manage", "inventory.manage"), writeLimit, validate({ params: idParams, body: productBody }), async (req, res) => {
  // Stock only changes through the adjust route, so it always has a log entry.
  const { stock: _ignored, ...body } = req.valid.body;
  const product = await Product.findByIdAndUpdate(req.valid.params.id, { $set: { ...body, variants: await withBarcodes(body.variants) } }, { returnDocument: "after" }).catch(dupBarcode);
  if (!product) throw notFound();
  clearPublicCache();
  audit(req, "catalog", "update", `Updated product ${product.name}`, product.id);
  res.json({ product: dto.panelProduct(product) });
});

/** Products are never hard-deleted while bills and orders point at them. */
router.delete("/products/:id", can("catalog.manage"), writeLimit, validate({ params: idParams }), async (req, res) => {
  const product = await Product.findByIdAndUpdate(req.valid.params.id, { $set: { active: false } }, { returnDocument: "after" });
  if (!product) throw notFound();
  clearPublicCache();
  audit(req, "catalog", "delete", `Removed product ${product.name}`, product.id);
  res.json({ product: dto.panelProduct(product) });
});

const stockBody = z.strictObject({ change: z.number().int().min(-1e6).max(1e6).refine((n) => n !== 0, "Enter a quantity"), reason: z.enum(["stock_in", "adjustment"]), note: text(200).optional() });

router.post("/products/:id/stock", can("inventory.manage"), writeLimit, validate({ params: idParams, body: stockBody }), async (req, res) => {
  const { change, reason, note } = req.valid.body;
  const result = await withTxn(async (session) => {
    const query = { _id: req.valid.params.id, ...(change < 0 ? { stock: { $gte: -change } } : {}) };
    const product = await Product.findOneAndUpdate(query, { $inc: { stock: change } }, { returnDocument: "after", session });
    if (!product) throw conflict("Stock can't go below zero.");
    const [log] = await StockLog.create([{ productId: product._id, change, reason, note, by: req.user._id }], { session });
    return { product, log };
  });
  clearPublicCache();
  audit(req, "inventory", "stock", `${result.product.name}: ${change > 0 ? "+" : ""}${change}`, result.product.id);
  res.json({ product: dto.panelProduct(result.product), log: dto.stockLog(result.log) });
});

router.post("/products/:id/barcode", can("inventory.manage", "catalog.manage"), writeLimit, validate({ params: idParams, body: z.strictObject({ variantId: text(40).min(1) }) }), async (req, res) => {
  const product = await Product.findById(req.valid.params.id);
  if (!product) throw notFound();
  const v = product.variants.find((x) => x.id === req.valid.body.variantId);
  if (!v) throw notFound();
  v.barcode = await newBarcode();
  await product.save();
  audit(req, "inventory", "barcode", `New barcode for ${product.name} ${v.label}`, product.id);
  res.json({ product: dto.panelProduct(product) });
});

router.get("/barcodes/:code", can("inventory.manage", "billing.manage", "catalog.manage"), validate({ params: z.strictObject({ code: z.string().regex(/^[0-9A-Za-z-]{4,32}$/) }) }), async (req, res) => {
  const product = await Product.findOne({ "variants.barcode": req.valid.params.code }).lean();
  if (!product) throw notFound("No product has this barcode.");
  res.json({ product: dto.panelProduct(product), variantId: product.variants.find((v) => v.barcode === req.valid.params.code).id });
});

/* ---------- Groomers ---------- */

const groomerBody = z.strictObject({ name: text(80).min(2), phone: text(20).optional().default(""), role: text(60).optional().default("Groomer"), experience: text(30).optional().default(""), speciality: text(160).optional().default(""), rating: z.number().min(0).max(5).optional(), color: z.string().regex(/^#[0-9a-fA-F]{6}$/), workStart: minutes, workEnd: minutes, weeklyOff: z.array(z.number().int().min(0).max(6)).max(7), leaveDays: z.array(isoDate).max(366), active: z.boolean() });

router.post("/groomers", can("schedule.manage", "staff.assign"), writeLimit, validate({ body: groomerBody }), async (req, res) => {
  const groomer = await Groomer.create(req.valid.body);
  clearPublicCache();
  audit(req, "schedule", "create", `Added groomer ${groomer.name}`, groomer.id);
  res.status(201).json({ groomer: dto.panelGroomer(groomer) });
});

router.put("/groomers/:id", can("schedule.manage", "staff.assign"), writeLimit, validate({ params: idParams, body: groomerBody }), async (req, res) => {
  const groomer = await Groomer.findByIdAndUpdate(req.valid.params.id, { $set: req.valid.body }, { returnDocument: "after" });
  if (!groomer) throw notFound();
  clearPublicCache();
  audit(req, "schedule", "update", `Updated groomer ${groomer.name}`, groomer.id);
  res.json({ groomer: dto.panelGroomer(groomer) });
});

/* ---------- Blocked dates and time slots ---------- */

router.get("/blocks", can("schedule.manage"), validate({ query: z.strictObject({ from: isoDate }) }), async (req, res) => {
  const rows = await SlotBlock.find({ date: { $gte: req.valid.query.from } }).sort({ date: 1, start: 1 }).limit(500).lean();
  res.json({ blocks: rows.map(dto.block) });
});

const blockBody = z.strictObject({ date: isoDate, start: minutes.nullish(), end: minutes.nullish(), reason: text(120).optional() });

router.post("/blocks", can("schedule.manage"), writeLimit, validate({ body: blockBody }), async (req, res) => {
  const { date, start, end, reason } = req.valid.body;
  if ((start == null) !== (end == null) || (start != null && end <= start)) throw badRequest("Choose a valid time range, or leave both empty to block the whole day.");
  const block = await SlotBlock.create({ date, start: start ?? undefined, end: end ?? undefined, reason });
  audit(req, "schedule", "block", `Blocked ${date}${start != null ? ` ${start}-${end}` : ""}`, block.id);
  res.status(201).json({ block: dto.block(block) });
});

router.delete("/blocks/:id", can("schedule.manage"), writeLimit, validate({ params: idParams }), async (req, res) => {
  await SlotBlock.deleteOne({ _id: req.valid.params.id });
  audit(req, "schedule", "unblock", "Removed a slot block", req.valid.params.id);
  res.json({ ok: true });
});

/* ---------- Coupons ---------- */

const couponBody = z.strictObject({ code: z.string().trim().regex(/^[A-Za-z0-9_-]{3,30}$/), type: z.enum(["percent", "flat"]), value: z.number().positive().max(1e6), minAmount: z.number().min(0).max(1e7), startDate: isoDate, endDate: isoDate, usageLimit: z.number().int().min(0).max(1e7), active: z.boolean(), description: text(200).optional().default("") });

const dupCoupon = (e) => {
  if (e?.code === 11000) throw conflict("A coupon with this code already exists.");
  throw e;
};

router.post("/coupons", can("catalog.manage", "billing.manage"), writeLimit, validate({ body: couponBody }), async (req, res) => {
  const coupon = await Coupon.create(req.valid.body).catch(dupCoupon);
  audit(req, "catalog", "create", `Added coupon ${coupon.code}`, coupon.id);
  res.status(201).json({ coupon: dto.coupon(coupon) });
});

router.put("/coupons/:id", can("catalog.manage", "billing.manage"), writeLimit, validate({ params: idParams, body: couponBody }), async (req, res) => {
  const coupon = await Coupon.findByIdAndUpdate(req.valid.params.id, { $set: req.valid.body }, { returnDocument: "after" }).catch(dupCoupon);
  if (!coupon) throw notFound();
  audit(req, "catalog", "update", `Updated coupon ${coupon.code}`, coupon.id);
  res.json({ coupon: dto.coupon(coupon) });
});

router.delete("/coupons/:id", can("catalog.manage", "billing.manage"), writeLimit, validate({ params: idParams }), async (req, res) => {
  const coupon = await Coupon.findByIdAndDelete(req.valid.params.id);
  if (coupon) audit(req, "catalog", "delete", `Deleted coupon ${coupon.code}`, coupon.id);
  res.json({ ok: true });
});

/* ---------- Settings ---------- */

const settingsBody = z.strictObject({
  storeName: text(80).min(1),
  tagline: text(120),
  address: text(300),
  phone: text(30),
  email: z.email().max(120),
  gstin: text(20),
  gstEnabled: z.boolean(),
  defaultServiceGst: z.number().min(0).max(50),
  openTime: minutes,
  closeTime: minutes,
  closedDays: z.array(z.number().int().min(0).max(6)).max(7),
  slotMinutes: z.union([z.literal(15), z.literal(30), z.literal(45), z.literal(60)]),
  slotCapacity: z.number().int().min(1).max(100),
  bookingWindowDays: z.number().int().min(1).max(365),
  holidays: z.array(isoDate).max(366),
  autoCancelHours: z.number().min(0).max(72),
  cancelCutoffHours: z.number().min(0).max(72),
  noShowFlagAt: z.number().int().min(1).max(50),
  pickupHoldDays: z.number().int().min(1).max(60),
  autoConfirm: z.boolean(),
  deliveryPincodes: z.array(z.string().regex(/^\d{6}$/)).max(500),
  deliveryCharge: z.number().min(0).max(1e5),
  freeDeliveryAbove: z.number().min(0).max(1e7),
  codLimit: z.number().min(0).max(1e7),
  invoicePrefix: z.string().regex(/^[A-Z0-9]{1,8}$/),
  templates: z.strictObject({ bookingConfirmed: text(500), reminder: text(500), orderReady: text(500) }),
}).partial();

router.put("/settings", can("settings.manage", "schedule.manage"), writeLimit, validate({ body: settingsBody }), async (req, res) => {
  const SCHEDULE = ["openTime", "closeTime", "closedDays", "slotMinutes", "slotCapacity", "bookingWindowDays", "holidays"];
  if (!req.permissions.has("settings.manage") && Object.keys(req.valid.body).some((k) => !SCHEDULE.includes(k))) throw badRequest("You can only change schedule settings.");
  const { openTime, closeTime } = req.valid.body;
  if (openTime != null && closeTime != null && closeTime <= openTime) throw badRequest("Closing time must be after opening time.");
  const settings = await saveSettings(req.valid.body);
  clearPublicCache();
  audit(req, "settings", "update", `Settings changed: ${Object.keys(req.valid.body).join(", ")}`);
  res.json({ settings });
});

/* ---------- Login OTP provider. The password goes in but never comes back out. ---------- */

router.get("/sms", can("settings.manage"), async (_req, res) => {
  res.json({ sms: smsView(await getSmsConfig()) });
});

const smsBody = z.strictObject({
  enabled: z.boolean(),
  customerId: text(80),
  password: z.string().min(1).max(200).optional(),
  demoEnabled: z.boolean(),
  demoPhone: z.string().regex(/^(\d{10})?$/, "Enter 10 digits"),
  demoCode: z.string().regex(/^(\d{4})?$/, "Enter 4 digits"),
});

router.put("/sms", can("settings.manage"), writeLimit, validate({ body: smsBody }), async (req, res) => {
  const body = req.valid.body;
  if (body.demoEnabled && (!body.demoPhone || !body.demoCode)) throw badRequest("Enter the demo number and OTP, or switch demo login off.");
  const next = await saveSmsConfig(body);
  if (body.enabled && !providerReady(next)) throw badRequest("Saved, but SMS stays off until the Customer ID and password are both set.");
  audit(req, "settings", "sms", `OTP settings changed (SMS ${body.enabled ? "on" : "off"}, demo ${body.demoEnabled ? "on" : "off"})`);
  res.json({ sms: smsView(next) });
});

router.post("/sms/test", can("settings.manage"), writeLimit, async (_req, res) => {
  const sms = await getSmsConfig();
  if (!sms.customerId || !sms.passwordSealed) throw badRequest("Save the Customer ID and password first.");
  await testConnection(sms).catch(() => {
    throw badRequest("Message Central refused these details. Check the Customer ID and password.");
  });
  res.json({ ok: true });
});

export default router;
