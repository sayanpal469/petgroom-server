import { Booking, Groomer, SlotBlock, SlotHold, SlotLoad } from "../models/index.js";
import { getSettings, storeNow, weekday } from "./misc.js";

const loadId = (date, minute) => `${date}|${minute}`;

/** Slot steps a booking occupies. A 45-minute booking on a 30-minute grid holds two steps. */
export function stepsFor(start, duration, stepSize) {
  const first = start - (start % stepSize);
  const out = [];
  for (let m = first; m < start + duration; m += stepSize) out.push(m);
  return out;
}

export function groomerWorks(g, date, settings) {
  if (!g.active) return false;
  if (settings.holidays.includes(date)) return false;
  if ((g.leaveDays ?? []).includes(date)) return false;
  return !(g.weeklyOff ?? []).includes(weekday(date));
}

const blockedBy = (blocks, minute) => blocks.some((b) => (b.start == null ? true : minute >= b.start && minute < b.end));

async function dayState(date, settings) {
  const [groomers, holds, loads, blocks] = await Promise.all([
    Groomer.find({ active: true }).lean(),
    SlotHold.find({ date }).select("minute groomerId bookingId").lean(),
    SlotLoad.find({ _id: { $gte: `${date}|`, $lt: `${date}|~` } }).lean(),
    SlotBlock.find({ date }).lean(),
  ]);
  const working = groomers.filter((g) => groomerWorks(g, date, settings));
  const busy = new Set(holds.map((h) => `${h.groomerId}|${h.minute}`));
  const load = new Map(loads.map((l) => [Number(l._id.split("|")[1]), l.count]));
  const minutesBooked = new Map();
  for (const h of holds) minutesBooked.set(String(h.groomerId), (minutesBooked.get(String(h.groomerId)) ?? 0) + settings.slotMinutes);
  return { working, busy, load, blocks, minutesBooked };
}

function freeGroomers(state, steps, start, duration) {
  return state.working.filter((g) => start >= g.workStart && start + duration <= g.workEnd && steps.every((m) => !state.busy.has(`${g._id}|${m}`)));
}

/** Available start times for a date. `groomerId` narrows them to one groomer. */
export async function slotsFor(date, duration, groomerId) {
  const settings = await getSettings();
  const now = storeNow();
  const closed = settings.holidays.includes(date) || (settings.closedDays ?? []).includes(weekday(date)) || date < now.date;
  const out = [];
  const state = closed ? null : await dayState(date, settings);

  for (let m = settings.openTime; m + duration <= settings.closeTime; m += settings.slotMinutes) {
    let available = false;
    let spots = 0;
    if (state) {
      const steps = stepsFor(m, duration, settings.slotMinutes);
      const past = date === now.date && m <= now.minutes + 30;
      const blocked = steps.some((s) => blockedBy(state.blocks, s));
      const full = steps.some((s) => (state.load.get(s) ?? 0) >= settings.slotCapacity);
      if (!past && !blocked && !full) {
        const free = freeGroomers(state, steps, m, duration);
        const pool = groomerId ? free.filter((g) => String(g._id) === groomerId) : free;
        available = pool.length > 0;
        spots = Math.min(pool.length, settings.slotCapacity - Math.max(...steps.map((s) => state.load.get(s) ?? 0)));
      }
    }
    out.push({ minutes: m, available, spots });
  }
  return out;
}

/** Least-loaded groomer free for the whole booking, which spreads work evenly across staff. */
export async function pickGroomer(date, start, duration) {
  const settings = await getSettings();
  const state = await dayState(date, settings);
  const steps = stepsFor(start, duration, settings.slotMinutes);
  const free = freeGroomers(state, steps, start, duration);
  free.sort((a, b) => (state.minutesBooked.get(String(a._id)) ?? 0) - (state.minutesBooked.get(String(b._id)) ?? 0));
  return free[0]?._id ?? null;
}

/**
 * Takes the slot inside the caller's transaction. Two races end in a duplicate-key error that
 * aborts the transaction: two bookings for one groomer (unique hold), and the store's capacity
 * being reached (the conditional upsert cannot match, so it tries to insert an existing _id).
 */
export async function reserve({ _id, date, start, duration, groomerId }, session) {
  const settings = await getSettings();
  const steps = stepsFor(start, duration, settings.slotMinutes);
  await SlotHold.insertMany(steps.map((minute) => ({ date, minute, groomerId, bookingId: _id })), { session, ordered: true });
  for (const minute of steps) {
    await SlotLoad.updateOne({ _id: loadId(date, minute), count: { $lt: settings.slotCapacity } }, { $inc: { count: 1 } }, { upsert: true, session });
  }
}

export async function release({ _id, date }, session) {
  const holds = await SlotHold.find({ bookingId: _id }).session(session).select("minute").lean();
  if (!holds.length) return;
  await SlotHold.deleteMany({ bookingId: _id }, { session });
  await SlotLoad.updateMany({ _id: { $in: holds.map((h) => loadId(date, h.minute)) } }, { $inc: { count: -1 } }, { session });
}

/** Whether a move or manual assignment is allowed: the groomer must work that day and hours. */
export async function groomerCanWork(groomerId, date, start, duration) {
  const settings = await getSettings();
  const g = await Groomer.findById(groomerId).lean();
  return Boolean(g && groomerWorks(g, date, settings) && start >= g.workStart && start + duration <= g.workEnd);
}

export async function slotIsOpen(date, start, duration) {
  const settings = await getSettings();
  if (settings.holidays.includes(date) || (settings.closedDays ?? []).includes(weekday(date))) return false;
  if (start < settings.openTime || start + duration > settings.closeTime) return false;
  const blocks = await SlotBlock.find({ date }).lean();
  return !stepsFor(start, duration, settings.slotMinutes).some((s) => blockedBy(blocks, s));
}

/** Staff workload for the assignment screen. */
export async function workload(date) {
  const rows = await Booking.aggregate([
    { $match: { date, status: { $nin: ["cancelled", "no_show"] } } },
    { $group: { _id: "$groomerId", bookings: { $sum: 1 }, minutes: { $sum: "$duration" } } },
  ]);
  return rows.map((r) => ({ groomerId: String(r._id), bookings: r.bookings, minutes: r.minutes }));
}
