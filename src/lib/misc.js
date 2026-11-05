import { env } from "../config/env.js";
import { Counter, AuditLog, Notification, Settings } from "../models/index.js";
import { logger } from "./logger.js";

/* ---------- Store time. The shop runs on India time whatever the server's zone is. ---------- */

const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

export function storeNow(at = new Date()) {
  const p = Object.fromEntries(fmt.formatToParts(at).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, minutes: Number(p.hour) * 60 + Number(p.minute) };
}

export const weekday = (iso) => new Date(`${iso}T00:00:00Z`).getUTCDay();

export function addDaysISO(iso, days) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Absolute moment of a store-local date and minute. */
export const storeInstant = (date, minute) => new Date(new Date(`${date}T00:00:00+05:30`).getTime() + minute * 60_000);

/* ---------- Settings. Cached briefly per worker; every booking reads them. ---------- */

export const DEFAULT_SETTINGS = {
  storeName: "Paws Station",
  tagline: "Pet Salon & Spa",
  address: "12 Jessore Road, Barasat, Kolkata – 700124, West Bengal",
  phone: "+91 98300 12345",
  email: "hello@pawsstation.in",
  gstin: "19ABCDE1234F1Z5",
  gstEnabled: true,
  defaultServiceGst: 18,
  openTime: 540,
  closeTime: 1200,
  closedDays: [],
  slotMinutes: 30,
  slotCapacity: 3,
  bookingWindowDays: 30,
  holidays: [],
  autoCancelHours: 2,
  cancelCutoffHours: 3,
  noShowFlagAt: 3,
  pickupHoldDays: 7,
  autoConfirm: true,
  deliveryPincodes: ["700124", "700125", "700126", "700129", "700049"],
  deliveryCharge: 50,
  freeDeliveryAbove: 999,
  codLimit: 5000,
  invoicePrefix: "PSB",
  templates: {
    bookingConfirmed: "Hi {name}, {pet}'s grooming is confirmed for {date} at {time}. Pay at the store after the service. – Paws Station",
    reminder: "Reminder: {pet}'s grooming is tomorrow at {time}. See you soon! – Paws Station",
    orderReady: "Hi {name}, your order #{order} is {status}. Pay {amount} on delivery / at the store. – Paws Station",
  },
};

let cached = null;
let cachedAt = 0;
const SETTINGS_TTL = env.isTest ? 0 : 15_000;

export async function getSettings() {
  if (cached && Date.now() - cachedAt < SETTINGS_TTL) return cached;
  const doc = await Settings.findById("store").lean();
  cached = { ...DEFAULT_SETTINGS, ...(doc?.data ?? {}) };
  cachedAt = Date.now();
  return cached;
}

export async function saveSettings(patch) {
  const next = { ...(await getSettings()), ...patch };
  await Settings.updateOne({ _id: "store" }, { $set: { data: next } }, { upsert: true });
  cached = next;
  cachedAt = Date.now();
  return next;
}

/* ---------- Sequential numbers. Inside a transaction a rollback gives the number back, so bills have no gaps. ---------- */

export async function nextSeq(name, start, session) {
  const res = await Counter.findOneAndUpdate({ _id: name }, [{ $set: { seq: { $add: [{ $ifNull: ["$seq", start] }, 1] } } }], {
    upsert: true,
    returnDocument: "after",
    updatePipeline: true,
    session,
  }).lean();
  return res.seq;
}

/* ---------- Audit and notifications never break the action that triggered them. ---------- */

export function audit(req, module, action, summary, targetId) {
  const u = req.user;
  AuditLog.create({ actorId: u?._id, actorName: u?.name, actorRole: u?.role, action, module, targetId: targetId ? String(targetId) : undefined, summary, ip: req.ip }).catch((err) =>
    logger.error({ err }, "audit write failed"),
  );
}

export function notify(userId, n) {
  if (!userId) return;
  Notification.create({ userId, ...n }).catch((err) => logger.error({ err }, "notification write failed"));
}
