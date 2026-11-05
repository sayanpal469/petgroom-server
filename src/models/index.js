import mongoose from "mongoose";

const { Schema, model, models } = mongoose;
const Id = Schema.Types.ObjectId;

/** Every model answers with `id` and without Mongo internals. */
const toJSON = {
  virtuals: true,
  flattenMaps: true,
  transform(_doc, ret) {
    delete ret._id;
    return ret;
  },
};
const opts = (extra = {}) => ({ timestamps: true, versionKey: false, toJSON, ...extra });

const addressSchema = new Schema(
  {
    label: String,
    kind: { type: String, enum: ["home", "office", "other"], default: "home" },
    line1: String,
    line2: String,
    city: String,
    pincode: String,
    state: String,
    phone: String,
    isDefault: Boolean,
  },
  { toJSON },
);

const userSchema = new Schema(
  {
    role: { type: String, enum: ["customer", "staff", "admin", "super_admin", "clinic"], required: true },
    name: { type: String, required: true, trim: true },
    phone: { type: String, trim: true },
    email: { type: String, trim: true, lowercase: true },
    passwordHash: { type: String, select: false },
    status: { type: String, enum: ["active", "disabled"], default: "active" },
    grants: { type: [String], default: [] },
    revokes: { type: [String], default: [] },
    groomerId: { type: Id, ref: "Groomer" },
    failedLogins: { type: Number, default: 0, select: false },
    lockedUntil: { type: Date, select: false },
    lastLoginAt: Date,
    // customer
    addresses: [addressSchema],
    notes: String,
    noShowCount: { type: Number, default: 0 },
    blocked: { type: Boolean, default: false },
    prefs: { type: Schema.Types.Mixed, default: {} },
  },
  opts(),
);
userSchema.index({ phone: 1 }, { unique: true, partialFilterExpression: { phone: { $type: "string" } } });
userSchema.index({ email: 1 }, { unique: true, partialFilterExpression: { email: { $type: "string" } } });
userSchema.index({ role: 1, createdAt: -1 });

const sessionSchema = new Schema(
  {
    tokenHash: { type: String, required: true, unique: true },
    userId: { type: Id, ref: "User", required: true, index: true },
    audience: { type: String, enum: ["customer", "panel"], required: true },
    expiresAt: { type: Date, required: true },
    userAgent: String,
    ip: String,
  },
  { versionKey: false, timestamps: true },
);
sessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const otpSchema = new Schema(
  {
    phone: { type: String, required: true, unique: true },
    codeHash: String,
    verificationId: String,
    attempts: { type: Number, default: 0 },
    expiresAt: { type: Date, required: true },
  },
  { versionKey: false },
);
otpSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const rateCounterSchema = new Schema({ _id: String, hits: Number, expiresAt: Date }, { versionKey: false });
rateCounterSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const counterSchema = new Schema({ _id: String, seq: { type: Number, default: 0 } }, { versionKey: false });

const petSchema = new Schema(
  {
    userId: { type: Id, ref: "User", required: true, index: true },
    name: { type: String, required: true, trim: true },
    type: { type: String, enum: ["dog", "cat"], required: true },
    breed: String,
    size: { type: String, enum: ["small", "medium", "large"], required: true },
    age: String,
    photo: String,
    vaccinated: { type: Boolean, default: false },
    notes: String,
    active: { type: Boolean, default: true },
  },
  opts(),
);
petSchema.index({ name: 1 });

const sized = { small: Number, medium: Number, large: Number };
const serviceSchema = new Schema(
  {
    slug: { type: String, unique: true, required: true },
    name: { type: String, required: true },
    short: String,
    category: { type: String, enum: ["bath", "styling", "hygiene", "package"] },
    icon: String,
    image: String,
    prices: sized,
    durations: sized,
    popular: Boolean,
    forCats: Boolean,
    gstRate: { type: Number, default: 18 },
    sac: { type: String, default: "999729" },
    active: { type: Boolean, default: true },
    order: { type: Number, default: 0 },
  },
  opts(),
);

const packageSchema = new Schema(
  {
    name: { type: String, required: true },
    description: String,
    visits: Number,
    price: Number,
    worth: Number,
    validityDays: Number,
    includes: [String],
    highlight: Boolean,
  },
  opts(),
);

const groomerSchema = new Schema(
  {
    name: { type: String, required: true },
    role: String,
    experience: String,
    speciality: String,
    rating: { type: Number, default: 5 },
    color: String,
    phone: String,
    workStart: Number,
    workEnd: Number,
    weeklyOff: [Number],
    leaveDays: [String],
    active: { type: Boolean, default: true },
  },
  opts(),
);

const variantSchema = new Schema({ id: { type: String, required: true }, label: String, price: Number, mrp: Number, barcode: String }, { _id: false, id: false });

const productSchema = new Schema(
  {
    slug: { type: String, unique: true, required: true },
    name: { type: String, required: true },
    category: { type: String, enum: ["food", "shampoo", "treats", "accessories", "toys"], index: true },
    petType: { type: String, enum: ["dog", "cat", "both"] },
    image: String,
    gallery: [String],
    variants: [variantSchema],
    stock: { type: Number, default: 0, min: 0 },
    rating: { type: Number, default: 0 },
    reviews: { type: Number, default: 0 },
    description: String,
    usage: String,
    highlights: [String],
    tag: String,
    gstRate: { type: Number, default: 18 },
    hsn: String,
    lowStockLevel: { type: Number, default: 5 },
    active: { type: Boolean, default: true, index: true },
  },
  opts(),
);
productSchema.index({ "variants.barcode": 1 }, { unique: true, sparse: true });

const pickupSchema = new Schema(
  {
    otpSealed: { type: String, select: false },
    generatedAt: Date,
    expiresAt: Date,
    attempts: { type: Number, default: 0 },
    verifiedAt: Date,
    verifiedBy: { type: Id, ref: "User" },
    verifiedByName: String,
  },
  { _id: false },
);

export const BOOKING_STATUS = ["pending", "confirmed", "scheduled", "checked_in", "grooming_started", "in_progress", "completed", "ready_for_pickup", "picked_up", "cancelled", "no_show"];

const bookingSchema = new Schema(
  {
    bookingNo: { type: String, unique: true, required: true },
    userId: { type: Id, ref: "User", required: true },
    petId: { type: Id, ref: "Pet", required: true },
    serviceIds: [{ type: Id, ref: "Service" }],
    serviceNames: [String],
    groomerId: { type: Id, ref: "Groomer" },
    date: { type: String, required: true },
    start: { type: Number, required: true },
    duration: { type: Number, required: true },
    status: { type: String, enum: BOOKING_STATUS, default: "pending" },
    source: { type: String, enum: ["online", "phone", "walkin"], default: "online" },
    notes: String,
    estimate: Number,
    photos: { before: String, after: String },
    rating: Number,
    invoiceId: { type: Id, ref: "Invoice" },
    cancelReason: String,
    history: { type: Map, of: Date, default: {} },
    acknowledgedAt: Date,
    pickup: { type: pickupSchema, default: () => ({}) },
  },
  opts(),
);
bookingSchema.index({ userId: 1, date: -1 });
bookingSchema.index({ date: 1, status: 1 });
bookingSchema.index({ groomerId: 1, date: 1 });

/** One document per groomer per slot step. The unique index is what stops double booking. */
const slotHoldSchema = new Schema(
  {
    date: { type: String, required: true },
    minute: { type: Number, required: true },
    groomerId: { type: Id, required: true },
    bookingId: { type: Id, required: true, index: true },
  },
  { versionKey: false },
);
slotHoldSchema.index({ date: 1, minute: 1, groomerId: 1 }, { unique: true });

/** Pets booked per slot step across the store, checked against the slot's capacity. */
const slotLoadSchema = new Schema({ _id: String, count: { type: Number, default: 0 } }, { versionKey: false });

const slotBlockSchema = new Schema({ date: { type: String, required: true, index: true }, start: Number, end: Number, reason: String }, opts());

const orderItemSchema = new Schema(
  { productId: { type: Id, ref: "Product" }, variantId: String, name: String, variant: String, image: String, price: Number, qty: Number, gstRate: Number, hsn: String },
  { _id: false },
);

const orderSchema = new Schema(
  {
    orderNo: { type: String, unique: true, required: true },
    userId: { type: Id, ref: "User", required: true },
    items: [orderItemSchema],
    fulfilment: { type: String, enum: ["delivery", "pickup", "next_grooming"], required: true },
    payment: { type: String, enum: ["COD", "PAY_AT_STORE"], required: true },
    status: { type: String, enum: ["placed", "confirmed", "packed", "out_for_delivery", "ready_for_pickup", "delivered", "cancelled"], default: "placed" },
    deliveryCharge: { type: Number, default: 0 },
    discount: { type: Number, default: 0 },
    couponCode: String,
    address: String,
    addressId: String,
    history: { type: Map, of: Date, default: {} },
    invoiceId: { type: Id, ref: "Invoice" },
    cancelReason: String,
  },
  opts(),
);
orderSchema.index({ userId: 1, createdAt: -1 });
orderSchema.index({ status: 1, createdAt: -1 });

const billItemSchema = new Schema(
  { key: String, kind: { type: String, enum: ["service", "product", "charge"] }, refId: String, variantId: String, name: String, qty: Number, price: Number, gstRate: Number, code: String },
  { _id: false },
);

const invoiceSchema = new Schema(
  {
    invoiceNo: { type: String, unique: true, required: true },
    date: { type: Date, default: Date.now },
    userId: { type: Id, ref: "User" },
    customerName: String,
    customerPhone: String,
    petName: String,
    source: { type: { type: String, enum: ["booking", "order", "walkin"] }, refId: String },
    items: [billItemSchema],
    discountPercent: Number,
    discountFlat: Number,
    discountLabel: String,
    gstEnabled: Boolean,
    payments: [{ mode: { type: String, enum: ["Cash", "UPI", "Card"] }, amount: Number, at: Date, reference: String, _id: false }],
    status: { type: String, enum: ["paid", "unpaid", "partly_paid", "cancelled"], default: "unpaid" },
    cancelReason: String,
    createdBy: { type: Id, ref: "User" },
  },
  opts(),
);
invoiceSchema.index({ userId: 1, date: -1 });
invoiceSchema.index({ date: -1 });
invoiceSchema.index({ status: 1 });

const couponSchema = new Schema(
  {
    code: { type: String, required: true, unique: true, uppercase: true, trim: true },
    type: { type: String, enum: ["percent", "flat"] },
    value: Number,
    minAmount: { type: Number, default: 0 },
    startDate: String,
    endDate: String,
    usageLimit: { type: Number, default: 0 },
    used: { type: Number, default: 0 },
    active: { type: Boolean, default: true },
    description: String,
  },
  opts(),
);

const stockLogSchema = new Schema(
  {
    productId: { type: Id, ref: "Product", required: true, index: true },
    change: Number,
    reason: { type: String, enum: ["sale", "stock_in", "adjustment", "cancel"] },
    refId: String,
    note: String,
    at: { type: Date, default: Date.now, index: true },
    by: { type: Id, ref: "User" },
  },
  { versionKey: false, toJSON },
);

const settingsSchema = new Schema({ _id: { type: String, default: "store" }, data: Schema.Types.Mixed }, { versionKey: false, timestamps: true });

const notificationSchema = new Schema(
  {
    userId: { type: Id, ref: "User", required: true },
    kind: { type: String, enum: ["booking", "order", "offer", "reminder", "assignment"], default: "booking" },
    title: String,
    message: String,
    href: String,
    unread: { type: Boolean, default: true },
  },
  opts(),
);
notificationSchema.index({ userId: 1, createdAt: -1 });

const prescriptionSchema = new Schema(
  {
    petId: { type: Id, ref: "Pet", required: true },
    fileId: { type: Id, required: true },
    takenOn: { type: String, required: true },
    note: String,
    size: Number,
    uploadedBy: { type: Id, ref: "User", required: true },
    uploadedByName: String,
  },
  opts(),
);
prescriptionSchema.index({ petId: 1, takenOn: -1, createdAt: -1 });

const auditSchema = new Schema(
  {
    actorId: { type: Id, ref: "User" },
    actorName: String,
    actorRole: String,
    action: { type: String, required: true },
    module: { type: String, required: true },
    targetId: String,
    summary: String,
    ip: String,
    at: { type: Date, default: Date.now },
  },
  { versionKey: false, toJSON },
);
auditSchema.index({ module: 1, at: -1 });
auditSchema.index({ at: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 730 });

const contentSchema = new Schema(
  { kind: { type: String, enum: ["gallery", "offer", "review", "faq"], required: true, index: true }, data: Schema.Types.Mixed, order: { type: Number, default: 0 } },
  opts(),
);

const enquirySchema = new Schema({ name: String, phone: String, message: String, handled: { type: Boolean, default: false } }, opts());

const leaseSchema = new Schema({ _id: String, until: Date, owner: String }, { versionKey: false });

const m = (name, schema) => models[name] ?? model(name, schema);

export const User = m("User", userSchema);
export const Session = m("Session", sessionSchema);
export const OtpChallenge = m("OtpChallenge", otpSchema);
export const RateCounter = m("RateCounter", rateCounterSchema);
export const Counter = m("Counter", counterSchema);
export const Pet = m("Pet", petSchema);
export const Service = m("Service", serviceSchema);
export const Package = m("Package", packageSchema);
export const Groomer = m("Groomer", groomerSchema);
export const Product = m("Product", productSchema);
export const Booking = m("Booking", bookingSchema);
export const SlotHold = m("SlotHold", slotHoldSchema);
export const SlotLoad = m("SlotLoad", slotLoadSchema);
export const SlotBlock = m("SlotBlock", slotBlockSchema);
export const Order = m("Order", orderSchema);
export const Invoice = m("Invoice", invoiceSchema);
export const Coupon = m("Coupon", couponSchema);
export const StockLog = m("StockLog", stockLogSchema);
export const Settings = m("Settings", settingsSchema);
export const Notification = m("Notification", notificationSchema);
export const Prescription = m("Prescription", prescriptionSchema);
export const AuditLog = m("AuditLog", auditSchema);
export const Content = m("Content", contentSchema);
export const Enquiry = m("Enquiry", enquirySchema);
export const Lease = m("Lease", leaseSchema);
