import { Router } from "express";
import { z } from "zod";
import { PERMISSIONS, ROLE_DEFAULTS } from "../config/permissions.js";
import { hashPassword } from "../lib/crypto.js";
import * as dto from "../lib/dto.js";
import { badRequest, conflict, notFound } from "../lib/errors.js";
import { readFile, CLINIC_BUCKET, decodeImage, storePrescription } from "../lib/media.js";
import { audit, storeNow } from "../lib/misc.js";
import { can, endAllSessions } from "../middleware/auth.js";
import { uploadLimit, writeLimit } from "../middleware/rateLimit.js";
import { idParams, isoDate, objectId, phone10, text, validate } from "../middleware/validate.js";
import { AuditLog, Booking, Enquiry, Groomer, Invoice, Order, Pet, Prescription, Product, StockLog, User } from "../models/index.js";
import { passwordRule } from "./panelAuth.js";

const router = Router();
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/* ---------- Accounts, roles and permissions (super admin) ---------- */

const PANEL_ROLE = z.enum(["staff", "admin", "clinic", "super_admin"]);
const permList = z.array(z.enum(PERMISSIONS)).max(PERMISSIONS.length);

router.get("/users", can("users.manage"), async (_req, res) => {
  const users = await User.find({ role: { $ne: "customer" } }).sort({ role: 1, name: 1 }).lean();
  res.json({ users: users.map(dto.panelUser), permissions: PERMISSIONS, roleDefaults: ROLE_DEFAULTS });
});

const createUser = z.strictObject({ name: text(80).min(2), email: z.email().max(120), phone: phone10.optional(), role: PANEL_ROLE, password: passwordRule, groomerId: objectId.nullish(), grants: permList.optional(), revokes: permList.optional() });

const dup = (e) => {
  if (e?.code === 11000) throw conflict("That email or phone is already in use.", "account_taken");
  throw e;
};

async function linkGroomer(groomerId, ignoreUser) {
  if (!groomerId) return;
  if (!(await Groomer.exists({ _id: groomerId }))) throw notFound("Groomer not found.");
  if (await User.exists({ groomerId, _id: { $ne: ignoreUser } })) throw conflict("That groomer already has a login.", "groomer_linked");
}

router.post("/users", can("users.manage"), writeLimit, validate({ body: createUser }), async (req, res) => {
  const { password, ...rest } = req.valid.body;
  await linkGroomer(rest.groomerId);
  const user = await User.create({ ...rest, groomerId: rest.role === "staff" ? rest.groomerId : undefined, passwordHash: await hashPassword(password) }).catch(dup);
  audit(req, "users", "create", `Created ${user.role} account for ${user.name}`, user.id);
  res.status(201).json({ user: dto.panelUser(user) });
});

const updateUser = z.strictObject({ name: text(80).min(2).optional(), email: z.email().max(120).optional(), phone: phone10.nullish(), role: PANEL_ROLE.optional(), status: z.enum(["active", "disabled"]).optional(), groomerId: objectId.nullish(), grants: permList.optional(), revokes: permList.optional() });

router.patch("/users/:id", can("users.manage"), writeLimit, validate({ params: idParams, body: updateUser }), async (req, res) => {
  const user = await User.findOne({ _id: req.valid.params.id, role: { $ne: "customer" } });
  if (!user) throw notFound("Account not found.");
  const body = req.valid.body;
  const self = user.id === req.user.id;
  if (self && (body.status === "disabled" || (body.role && body.role !== user.role))) throw badRequest("You can't change your own role or disable your own account.");
  const losesSuper = user.role === "super_admin" && ((body.role && body.role !== "super_admin") || body.status === "disabled");
  if (losesSuper && (await User.countDocuments({ role: "super_admin", status: "active" })) <= 1) throw badRequest("There must always be one active super admin.");

  if (body.groomerId !== undefined) await linkGroomer(body.groomerId, user._id);
  const accessChanged = (body.role && body.role !== user.role) || body.status === "disabled";
  if (body.phone === null) {
    user.phone = undefined;
    delete body.phone;
  }
  user.set({ ...body, groomerId: body.groomerId ?? (body.groomerId === null ? undefined : user.groomerId) });
  await user.save().catch(dup);
  if (accessChanged) await endAllSessions(user._id);
  audit(req, "users", "update", `Updated account ${user.name}: ${Object.keys(body).join(", ")}`, user.id);
  res.json({ user: dto.panelUser(user) });
});

router.post("/users/:id/password", can("users.manage"), writeLimit, validate({ params: idParams, body: z.strictObject({ password: passwordRule }) }), async (req, res) => {
  const user = await User.findOne({ _id: req.valid.params.id, role: { $ne: "customer" } });
  if (!user) throw notFound("Account not found.");
  user.passwordHash = await hashPassword(req.valid.body.password);
  user.failedLogins = 0;
  user.lockedUntil = undefined;
  await user.save();
  await endAllSessions(user._id);
  audit(req, "users", "password_reset", `Reset the password of ${user.name}`, user.id);
  res.json({ ok: true });
});

const auditQuery = z.strictObject({ module: text(30).optional(), before: z.iso.datetime().optional() });

router.get("/audit", can("audit.view"), validate({ query: auditQuery }), async (req, res) => {
  const { module, before } = req.valid.query;
  const rows = await AuditLog.find({ ...(module ? { module } : {}), ...(before ? { at: { $lt: new Date(before) } } : {}) }).sort({ at: -1 }).limit(100).lean();
  res.json({ rows: rows.map(dto.auditRow) });
});

/* ---------- Reports read the requested period directly, beyond the panel's rolling window. ---------- */

const range = z.strictObject({ from: isoDate, to: isoDate });

router.get("/reports/raw", can("reports.view"), validate({ query: range }), async (req, res) => {
  const { from, to } = req.valid.query;
  const start = new Date(`${from}T00:00:00+05:30`);
  const end = new Date(`${to}T23:59:59.999+05:30`);
  const [invoices, bookings, orders, stockLogs] = await Promise.all([
    Invoice.find({ date: { $gte: start, $lte: end } }).sort({ date: 1 }).limit(20000).lean(),
    Booking.find({ date: { $gte: from, $lte: to } }).limit(20000).lean(),
    Order.find({ createdAt: { $gte: start, $lte: end } }).limit(20000).lean(),
    StockLog.find({ at: { $gte: start, $lte: end } }).sort({ at: -1 }).limit(5000).lean(),
  ]);
  res.json({ invoices: invoices.map(dto.panelInvoice), bookings: bookings.map(dto.panelBooking), orders: orders.map(dto.panelOrder), stockLogs: stockLogs.map(dto.stockLog) });
});

router.get("/overview", can("audit.view", "users.manage"), async (_req, res) => {
  const [customers, pets, bookings, orders, invoices, products, staff, enquiries] = await Promise.all([
    User.countDocuments({ role: "customer" }),
    Pet.countDocuments({ active: true }),
    Booking.countDocuments(),
    Order.countDocuments(),
    Invoice.countDocuments({ status: { $ne: "cancelled" } }),
    Product.countDocuments({ active: true }),
    User.countDocuments({ role: { $ne: "customer" }, status: "active" }),
    Enquiry.countDocuments({ handled: false }),
  ]);
  res.json({ customers, pets, bookings, orders, invoices, products, staff, enquiries });
});

/* ---------- Clinic: prescription images, JPEG only, reachable only with clinic permissions. ---------- */

const petCard = (p, owner) => ({ id: String(p._id), name: p.name, type: p.type, breed: p.breed ?? "", age: p.age ?? "", size: p.size, photo: p.photo, ownerName: owner?.name ?? "", ownerPhone: dto.maskPhone(owner?.phone) });

router.get("/clinic/pets", can("clinic.view", "clinic.upload"), validate({ query: z.strictObject({ q: text(40).min(2) }) }), async (req, res) => {
  const q = req.valid.query.q;
  const digits = q.replace(/\D/g, "");
  const rx = new RegExp(escapeRegex(q), "i");
  const owners = await User.find({ role: "customer", $or: [{ name: rx }, ...(digits.length >= 4 ? [{ phone: new RegExp(escapeRegex(digits)) }] : [])] }).select("_id").limit(50).lean();
  const pets = await Pet.find({ active: true, $or: [{ name: rx }, { userId: { $in: owners.map((o) => o._id) } }] }).limit(25).lean();
  const users = await User.find({ _id: { $in: pets.map((p) => p.userId) } }).select("name phone").lean();
  const byId = new Map(users.map((u) => [String(u._id), u]));
  res.json({ pets: pets.map((p) => petCard(p, byId.get(String(p.userId)))) });
});

router.get("/clinic/pets/:id", can("clinic.view", "clinic.upload"), validate({ params: idParams }), async (req, res) => {
  const pet = await Pet.findById(req.valid.params.id).lean();
  if (!pet) throw notFound("Pet not found.");
  const [owner, rows] = await Promise.all([User.findById(pet.userId).select("name phone").lean(), Prescription.find({ petId: pet._id }).sort({ takenOn: -1, createdAt: -1 }).limit(500).lean()]);
  res.json({ pet: petCard(pet, owner), prescriptions: rows.map(dto.prescription) });
});

const upload = z.strictObject({ image: z.string().max(12_000_000), takenOn: isoDate.optional(), note: text(200).optional() });

router.post("/clinic/pets/:id/prescriptions", can("clinic.upload"), uploadLimit, validate({ params: idParams, body: upload }), async (req, res) => {
  const pet = await Pet.findById(req.valid.params.id).select("_id name").lean();
  if (!pet) throw notFound("Pet not found.");
  const today = storeNow().date;
  const takenOn = req.valid.body.takenOn ?? today;
  if (takenOn > today) throw badRequest("The date can't be in the future.");
  const { fileId, size } = await storePrescription(decodeImage(req.valid.body.image), `prescription-${takenOn}.jpg`, { petId: String(pet._id) });
  const row = await Prescription.create({ petId: pet._id, fileId, takenOn, note: req.valid.body.note, size, uploadedBy: req.user._id, uploadedByName: req.user.name });
  audit(req, "clinic", "upload", `Prescription image added for ${pet.name}`, row.id);
  res.status(201).json({ prescription: dto.prescription(row) });
});

router.get("/clinic/prescriptions/:id/image", can("clinic.view"), validate({ params: idParams }), async (req, res) => {
  const row = await Prescription.findById(req.valid.params.id).lean();
  if (!row) throw notFound("Image not found.");
  const data = await readFile(CLINIC_BUCKET, row.fileId);
  audit(req, "clinic", "view", "Viewed a prescription image", row._id);
  res.json({ filename: `prescription-${row.takenOn}.jpg`, base64: data.toString("base64") });
});

export default router;
