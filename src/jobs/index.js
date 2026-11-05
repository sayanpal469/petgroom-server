import { randomUUID } from "node:crypto";
import { setStatus } from "../lib/bookings.js";
import { setOrderStatus } from "../lib/commerce.js";
import { logger } from "../lib/logger.js";
import { addDaysISO, getSettings, storeInstant, storeNow } from "../lib/misc.js";
import { Booking, Lease, Notification, Order } from "../models/index.js";

const owner = randomUUID();
const EVERY_MS = 5 * 60_000;

/** With several workers or servers, only the holder of this lease runs the jobs. */
async function takeLease() {
  const now = new Date();
  try {
    const res = await Lease.findOneAndUpdate({ _id: "jobs", $or: [{ until: { $lt: now } }, { owner }] }, { $set: { owner, until: new Date(now.getTime() + EVERY_MS) } }, { upsert: true, returnDocument: "after" }).lean();
    return res?.owner === owner;
  } catch (e) {
    if (e?.code === 11000) return false;
    throw e;
  }
}

export async function autoCancelUnconfirmed(settings) {
  const now = storeNow();
  const due = await Booking.find({ status: "pending", date: { $lte: addDaysISO(now.date, 1) } });
  for (const b of due) {
    if (storeInstant(b.date, b.start).getTime() - settings.autoCancelHours * 3600_000 > Date.now()) continue;
    await setStatus(b, "cancelled", { reason: "Not confirmed in time" }).catch((err) => logger.error({ err }, "auto cancel failed"));
  }
}

export async function expireUncollectedOrders(settings) {
  const before = new Date(Date.now() - settings.pickupHoldDays * 86400_000);
  const stale = await Order.find({ status: "ready_for_pickup", updatedAt: { $lt: before } });
  for (const o of stale) await setOrderStatus(o, "cancelled", { reason: "Not collected in time" }).catch((err) => logger.error({ err }, "pickup expiry failed"));
}

export async function sendReminders() {
  const tomorrow = addDaysISO(storeNow().date, 1);
  const rows = await Booking.find({ date: tomorrow, status: { $in: ["confirmed", "scheduled"] } }).select("userId bookingNo").lean();
  for (const b of rows) {
    const href = `/account/bookings/${b._id}`;
    await Notification.updateOne({ userId: b.userId, kind: "reminder", href }, { $setOnInsert: { title: "Grooming tomorrow", message: `Reminder for booking #${b.bookingNo}.`, unread: true } }, { upsert: true });
  }
}

async function tick() {
  try {
    if (!(await takeLease())) return;
    const settings = await getSettings();
    await autoCancelUnconfirmed(settings);
    await expireUncollectedOrders(settings);
    await sendReminders();
  } catch (err) {
    logger.error({ err }, "scheduled job failed");
  }
}

export function startJobs() {
  const t = setInterval(tick, EVERY_MS);
  t.unref();
  return t;
}
