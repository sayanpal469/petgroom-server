import { effectivePermissions } from "../config/permissions.js";
import { billTotals } from "./money.js";
import { pickupCode } from "./bookings.js";

/** Explicit shapes for everything that leaves the API. A field reaches the browser only if it is listed here. */
const id = (v) => (v ? String(v) : null);
const iso = (d) => (d ? new Date(d).toISOString() : undefined);
const historyOf = (h) => Object.fromEntries((h instanceof Map ? [...h.entries()] : Object.entries(h ?? {})).map(([k, v]) => [k, iso(v)]));

export const formatPhone = (p) => (p ? `+91 ${p.slice(0, 5)} ${p.slice(5)}` : "");
export const maskPhone = (p) => (p ? `+91 ••••• ••${p.slice(-3)}` : "");

export const panelUser = (u) => ({
  id: id(u._id),
  name: u.name,
  email: u.email,
  phone: u.phone ?? "",
  role: u.role,
  status: u.status,
  groomerId: id(u.groomerId),
  grants: u.grants ?? [],
  revokes: u.revokes ?? [],
  permissions: effectivePermissions(u),
  lastLoginAt: iso(u.lastLoginAt),
  createdAt: iso(u.createdAt),
});

export const address = (a) => ({ id: id(a._id), label: a.label, kind: a.kind, line1: a.line1, line2: a.line2 ?? "", city: a.city, pincode: a.pincode, state: a.state, phone: a.phone, isDefault: Boolean(a.isDefault) });

export const customerSelf = (u) => ({
  id: id(u._id),
  name: u.name,
  firstName: u.name.split(" ")[0],
  phone: formatPhone(u.phone),
  email: u.email ?? "",
  memberSince: String(new Date(u.createdAt).getFullYear()),
  addresses: (u.addresses ?? []).map(address),
  prefs: u.prefs ?? {},
  needsProfile: u.name === "New Customer",
});

export const pet = (p) => ({ id: id(p._id), name: p.name, type: p.type, breed: p.breed ?? "", size: p.size, age: p.age ?? "", photo: p.photo || "/images/pets/golden-bruno.jpg", vaccinated: Boolean(p.vaccinated), notes: p.notes });
export const panelPet = (p) => ({ ...pet(p), customerId: id(p.userId) });

const svc = (s) => ({ id: id(s._id), slug: s.slug, name: s.name, short: s.short, category: s.category, icon: s.icon, image: s.image, prices: s.prices, durations: s.durations, popular: Boolean(s.popular), forCats: Boolean(s.forCats) });
export const service = svc;
export const panelService = (s) => ({ ...svc(s), gstRate: s.gstRate, sac: s.sac, active: s.active });
export const pkg = (p) => ({ id: id(p._id), name: p.name, description: p.description, visits: p.visits, price: p.price, worth: p.worth, validityDays: p.validityDays, includes: p.includes, highlight: Boolean(p.highlight) });

export const groomer = (g) => ({ id: id(g._id), name: g.name, role: g.role, experience: g.experience, speciality: g.speciality, rating: g.rating, color: g.color });
export const panelGroomer = (g) => ({ ...groomer(g), phone: g.phone ?? "", workStart: g.workStart, workEnd: g.workEnd, weeklyOff: g.weeklyOff ?? [], leaveDays: g.leaveDays ?? [], active: g.active });

const variant = (v) => ({ id: v.id, label: v.label, price: v.price, mrp: v.mrp });
export const product = (p) => ({
  id: id(p._id), slug: p.slug, name: p.name, category: p.category, petType: p.petType, image: p.image, gallery: p.gallery ?? [], variants: p.variants.map(variant),
  // Exact stock is internal; the shop only needs to know about low and out-of-stock.
  stock: Math.min(p.stock, 25), rating: p.rating, reviews: p.reviews, description: p.description, usage: p.usage, highlights: p.highlights ?? [], tag: p.tag,
});
export const panelProduct = (p) => ({ ...product(p), stock: p.stock, variants: p.variants.map((v) => ({ ...variant(v), barcode: v.barcode ?? "" })), gstRate: p.gstRate, hsn: p.hsn ?? "", lowStockLevel: p.lowStockLevel, active: p.active });

export const customerBooking = (b) => ({
  id: id(b._id), bookingNo: b.bookingNo, petId: id(b.petId), serviceIds: (b.serviceIds ?? []).map(id), serviceNames: b.serviceNames ?? [], groomerId: id(b.groomerId), date: b.date, startMinutes: b.start, durationMinutes: b.duration,
  status: b.status, estimatedPrice: b.estimate, notes: b.notes, photos: b.photos?.before && b.photos?.after ? { before: b.photos.before, after: b.photos.after } : undefined, rating: b.rating, invoiceId: b.invoiceId ? id(b.invoiceId) : undefined,
  history: historyOf(b.history),
});

/** The OTP is only shown to the booking's owner, and only while the pet waits for pickup. */
export const customerBookingDetail = (b) => ({ ...customerBooking(b), pickupOtp: pickupCode(b) ?? undefined, pickupExpiresAt: b.status === "ready_for_pickup" ? iso(b.pickup?.expiresAt) : undefined, pickedUpAt: iso(b.pickup?.verifiedAt) });

export const panelBooking = (b) => ({
  id: id(b._id), bookingNo: b.bookingNo, customerId: id(b.userId), petId: id(b.petId), serviceIds: (b.serviceIds ?? []).map(id), serviceNames: b.serviceNames ?? [], groomerId: id(b.groomerId), date: b.date, start: b.start, duration: b.duration,
  status: b.status, source: b.source, notes: b.notes, estimate: b.estimate, photos: b.photos ?? undefined, invoiceId: b.invoiceId ? id(b.invoiceId) : undefined, createdAt: iso(b.createdAt), cancelReason: b.cancelReason, history: historyOf(b.history),
  acknowledgedAt: iso(b.acknowledgedAt), pickup: { generatedAt: iso(b.pickup?.generatedAt), expiresAt: iso(b.pickup?.expiresAt), attempts: b.pickup?.attempts ?? 0, verifiedAt: iso(b.pickup?.verifiedAt), verifiedByName: b.pickup?.verifiedByName },
});

const orderBase = (o) => ({
  id: id(o._id), orderNo: o.orderNo, placedAt: iso(o.createdAt),
  items: o.items.map((i) => ({ productId: id(i.productId), variantId: i.variantId, name: i.name, variant: i.variant, image: i.image, price: i.price, qty: i.qty })),
  fulfilment: o.fulfilment, payment: o.payment, status: o.status, deliveryCharge: o.deliveryCharge, discount: o.discount, history: historyOf(o.history), invoiceId: o.invoiceId ? id(o.invoiceId) : undefined,
});
export const customerOrder = (o) => ({ ...orderBase(o), addressId: o.addressId, address: o.address });
export const panelOrder = (o) => ({ ...orderBase(o), customerId: id(o.userId), address: o.address, cancelReason: o.cancelReason });

export const panelInvoice = (i) => ({
  id: id(i._id), invoiceNo: i.invoiceNo, date: iso(i.date), customerId: id(i.userId), customerName: i.customerName, customerPhone: i.customerPhone, petName: i.petName,
  source: i.source?.type ? { type: i.source.type, refId: i.source.refId } : { type: "walkin" },
  items: i.items.map((x) => ({ key: x.key, kind: x.kind, refId: x.refId, variantId: x.variantId, name: x.name, qty: x.qty, price: x.price, gstRate: x.gstRate, code: x.code })),
  discountPercent: i.discountPercent, discountFlat: i.discountFlat, discountLabel: i.discountLabel, gstEnabled: i.gstEnabled, payments: (i.payments ?? []).map((p) => ({ mode: p.mode, amount: p.amount, at: iso(p.at), reference: p.reference })), status: i.status, cancelReason: i.cancelReason,
});

export const customerInvoice = (i) => {
  const hasService = i.items.some((x) => x.kind === "service");
  return {
    id: id(i._id), invoiceNo: i.invoiceNo, date: iso(i.date), kind: hasService ? "service" : "product", summary: i.items.filter((x) => x.kind !== "charge").map((x) => x.name).slice(0, 2).join(" + "), petName: i.petName,
    items: i.items.map((x) => ({ name: x.name, qty: x.qty, price: x.price, gstRate: x.gstRate, code: x.code })), discountPercent: i.discountPercent, discountFlat: i.discountFlat, discountLabel: i.discountLabel, gstEnabled: i.gstEnabled,
    payments: (i.payments ?? []).map((p) => ({ mode: p.mode, amount: p.amount })), status: i.status, total: billTotals(i).total, customerName: i.customerName, customerPhone: i.customerPhone,
  };
};

export const customer = (u) => ({ id: id(u._id), name: u.name, phone: formatPhone(u.phone), email: u.email, address: u.addresses?.[0] ? [u.addresses[0].line1, u.addresses[0].line2, u.addresses[0].city, u.addresses[0].pincode].filter(Boolean).join(", ") : undefined, notes: u.notes, noShowCount: u.noShowCount ?? 0, createdAt: iso(u.createdAt), blocked: Boolean(u.blocked) });

export const coupon = (c) => ({ id: id(c._id), code: c.code, type: c.type, value: c.value, minAmount: c.minAmount, startDate: c.startDate, endDate: c.endDate, usageLimit: c.usageLimit, used: c.used, active: c.active, description: c.description });
export const stockLog = (l) => ({ id: id(l._id), productId: id(l.productId), change: l.change, reason: l.reason, refId: l.refId, note: l.note, at: iso(l.at) });
export const notification = (n) => ({ id: id(n._id), kind: n.kind, title: n.title, message: n.message, at: iso(n.createdAt), unread: n.unread, href: n.href });
export const block = (b) => ({ id: id(b._id), date: b.date, start: b.start ?? null, end: b.end ?? null, reason: b.reason ?? "" });
export const prescription = (p) => ({ id: id(p._id), petId: id(p.petId), takenOn: p.takenOn, note: p.note ?? "", size: p.size, uploadedByName: p.uploadedByName, createdAt: iso(p.createdAt) });
export const auditRow = (a) => ({ id: id(a._id), actorName: a.actorName ?? "System", actorRole: a.actorRole ?? "", action: a.action, module: a.module, summary: a.summary, ip: a.ip, at: iso(a.at) });

/** Storefront-safe settings: no invoice prefix, templates or delivery rules beyond what checkout needs. */
export const publicStore = (s) => ({
  name: s.storeName, tagline: s.tagline, phone: s.phone, phoneRaw: s.phone.replace(/\D/g, ""), email: s.email, address: s.address, gstin: s.gstin, gstEnabled: s.gstEnabled,
  openTime: s.openTime, closeTime: s.closeTime, freeDeliveryAbove: s.freeDeliveryAbove, deliveryCharge: s.deliveryCharge, codLimit: s.codLimit, deliveryPincodes: s.deliveryPincodes, cancelCutoffHours: s.cancelCutoffHours, bookingWindowDays: s.bookingWindowDays, holidays: s.holidays,
});
