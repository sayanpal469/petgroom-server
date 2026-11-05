import { Router } from "express";
import { z } from "zod";
import { checkCoupon } from "../lib/commerce.js";
import * as dto from "../lib/dto.js";
import { conflict } from "../lib/errors.js";
import { getSettings } from "../lib/misc.js";
import { slotsFor } from "../lib/slots.js";
import { enquiryLimit } from "../middleware/rateLimit.js";
import { isoDate, objectId, phone10, text, validate } from "../middleware/validate.js";
import { Content, Enquiry, Groomer, Package, Pet, Product, Service } from "../models/index.js";

const router = Router();

/** Same payload for every visitor, so one short-lived copy per worker takes the load of a traffic spike. */
let cache = null;
let cachedAt = 0;
const CACHE_MS = process.env.NODE_ENV === "test" ? 0 : 20_000;

export const clearPublicCache = () => {
  cache = null;
};

router.get("/bootstrap", async (_req, res) => {
  if (!cache || Date.now() - cachedAt > CACHE_MS) {
    const [settings, services, packages, groomers, products, content] = await Promise.all([
      getSettings(),
      Service.find({ active: true }).sort({ order: 1 }).lean(),
      Package.find().sort({ price: 1 }).lean(),
      Groomer.find({ active: true }).lean(),
      Product.find({ active: true }).sort({ createdAt: 1 }).limit(1000).lean(),
      Content.find().sort({ order: 1 }).lean(),
    ]);
    const of = (kind) => content.filter((c) => c.kind === kind).map((c) => ({ id: String(c._id), ...c.data }));
    cache = {
      store: dto.publicStore(settings),
      services: services.map(dto.service),
      packages: packages.map(dto.pkg),
      groomers: groomers.map(dto.groomer),
      products: products.map(dto.product),
      gallery: of("gallery"),
      offers: of("offer"),
      reviews: of("review"),
      faqs: of("faq"),
    };
    cachedAt = Date.now();
  }
  res.json(cache);
});

const slotQuery = z.strictObject({
  date: isoDate,
  serviceIds: z.string().regex(/^[0-9a-f]{24}(,[0-9a-f]{24})*$/i),
  petId: objectId.optional(),
  size: z.enum(["small", "medium", "large"]).optional(),
  groomerId: objectId.optional(),
});

router.get("/slots", validate({ query: slotQuery }), async (req, res) => {
  const { date, serviceIds, petId, size, groomerId } = req.valid.query;
  let petSize = size;
  if (!petSize && petId) petSize = (await Pet.findById(petId).select("size").lean())?.size;
  const services = await Service.find({ _id: { $in: serviceIds.split(",") }, active: true }).select("durations").lean();
  const duration = services.reduce((s, x) => s + (x.durations?.[petSize ?? "medium"] ?? 0), 0);
  if (!duration) throw conflict("Choose a service first.");
  res.json({ duration, slots: await slotsFor(date, duration, groomerId) });
});

router.post("/coupons/check", validate({ body: z.strictObject({ code: text(30).min(1), subtotal: z.number().nonnegative().max(1e7) }) }), async (req, res) => {
  const { coupon, discount } = await checkCoupon(req.valid.body.code, req.valid.body.subtotal);
  res.json({ code: coupon.code, discount, label: coupon.description });
});

router.post("/enquiries", enquiryLimit, validate({ body: z.strictObject({ name: text(80).min(2), phone: phone10, message: text(1000).min(5) }) }), async (req, res) => {
  await Enquiry.create(req.valid.body);
  res.status(201).json({ ok: true });
});

export default router;
