import { withTxn } from "../config/db.js";
import { Booking, Pet, Service, User } from "../models/index.js";
import { randomDigits, safeEqual, seal, unseal } from "./crypto.js";
import { advanceNeeded, refundAdvance } from "./advance.js";
import { badRequest, conflict, notFound } from "./errors.js";
import { tripPrice } from "./geo.js";
import { addDaysISO, getSettings, nextSeq, notify, storeInstant, storeNow } from "./misc.js";
import { groomerCanWork, pickGroomer, release, reserve, slotIsOpen } from "./slots.js";

const FORWARD = {
  pending: ["confirmed", "cancelled"],
  confirmed: ["scheduled", "checked_in", "cancelled", "no_show"],
  scheduled: ["checked_in", "cancelled", "no_show"],
  checked_in: ["grooming_started", "cancelled"],
  grooming_started: ["in_progress", "completed"],
  in_progress: ["completed"],
  completed: ["ready_for_pickup"],
  // ready_for_pickup -> picked_up happens only through verifyPickup.
};

export const LABEL = {
  pending: "awaiting confirmation",
  confirmed: "confirmed",
  scheduled: "scheduled",
  checked_in: "checked in",
  grooming_started: "started",
  in_progress: "in progress",
  completed: "completed",
  ready_for_pickup: "ready for pickup",
  picked_up: "picked up",
  cancelled: "cancelled",
  no_show: "marked as no-show",
};

const staffUserFor = async (groomerId) => (groomerId ? User.findOne({ groomerId, role: "staff", status: "active" }).select("_id").lean() : null);
const dupKey = (e) => e?.code === 11000 || e?.cause?.code === 11000;

export async function notifyStaff(groomerId, n) {
  const u = await staffUserFor(groomerId);
  if (u) notify(u._id, { kind: "assignment", href: "/my-work", ...n });
}

async function priceBooking(pet, serviceIds) {
  const services = await Service.find({ _id: { $in: serviceIds }, active: true }).lean();
  if (services.length !== new Set(serviceIds).size) throw badRequest("One of the selected services is not available.");
  return {
    serviceNames: services.map((s) => s.name),
    estimate: services.reduce((sum, s) => sum + (s.prices?.[pet.size] ?? 0), 0),
    duration: services.reduce((sum, s) => sum + (s.durations?.[pet.size] ?? 0), 0),
  };
}

/** Prices the trips the customer asked for. Locations come from the browser; prices never do. */
function pricePickDrop(settings, pickDrop) {
  if (!pickDrop || (!pickDrop.pickup && !pickDrop.drop)) return undefined;
  if (!settings.pickDropEnabled) throw badRequest("Pick & drop isn't available right now.", "pickdrop_off");
  const legs = {};
  for (const leg of ["pickup", "drop"]) {
    const loc = pickDrop[leg];
    if (!loc) continue;
    const price = tripPrice(settings, loc);
    if (!price) throw badRequest("Pick & drop isn't available right now.", "pickdrop_off");
    if (!price.inRange) throw badRequest(`That ${leg} address is ${price.km} km away. We pick up and drop within ${settings.pickDropMaxKm} km of the store.`, "pickdrop_far");
    legs[leg] = { ...loc, km: price.km, charge: price.charge };
  }
  const charge = (legs.pickup?.charge ?? 0) + (legs.drop?.charge ?? 0);
  return { ...legs, charge, stage: "requested", history: { requested: new Date() } };
}

/** Creates a booking and holds its slot. With "any available" it retries once if another customer takes the picked groomer first. */
export async function createBooking({ userId, petId, serviceIds, groomerId, date, start, notes, source, pickDrop }) {
  const settings = await getSettings();
  const pet = await Pet.findOne({ _id: petId, userId, active: true }).lean();
  if (!pet) throw notFound("Pet not found.");
  const { serviceNames, estimate, duration } = await priceBooking(pet, serviceIds);
  const trips = pricePickDrop(settings, pickDrop);
  // Bookings the store adds by phone or at the counter never ask for an online payment.
  const advanceAmount = source === "online" ? await advanceNeeded(estimate + (trips?.charge ?? 0)) : 0;
  const advance = advanceAmount ? { amount: advanceAmount, status: "due", dueBy: new Date(Date.now() + settings.advanceHoldMinutes * 60_000) } : undefined;

  const now = storeNow();
  if (date < now.date || (date === now.date && start <= now.minutes)) throw badRequest("Please choose a future time.");
  if (source === "online" && date > addDaysISO(now.date, settings.bookingWindowDays)) throw badRequest("That date is too far ahead.");
  if (!(await slotIsOpen(date, start, duration))) throw conflict("That time is not available.", "slot_unavailable");
  if (groomerId && !(await groomerCanWork(groomerId, date, start, duration))) throw conflict("That groomer is not working at this time.", "slot_unavailable");

  for (let attempt = 0; attempt < 3; attempt++) {
    const assigned = groomerId ?? (await pickGroomer(date, start, duration));
    if (!assigned) throw conflict("That time was just taken. Please pick another slot.", "slot_unavailable");
    try {
      const booking = await withTxn(async (session) => {
        const seq = await nextSeq("booking", 1000, session);
        // A booking waiting for its booking amount stays pending until the payment arrives.
        const status = settings.autoConfirm && !advance ? "confirmed" : "pending";
        const history = { booked: new Date(), ...(status === "confirmed" ? { confirmed: new Date() } : {}) };
        const [doc] = await Booking.create(
          [{ bookingNo: `PSK${seq}`, userId, petId, serviceIds, serviceNames, groomerId: assigned, date, start, duration, status, source, notes, estimate, history, advance, pickDrop: trips }],
          { session },
        );
        await reserve(doc, session);
        return doc;
      });
      if (advance) notify(userId, { kind: "booking", title: "Pay the booking amount", message: `Pay ₹${advance.amount} within ${settings.advanceHoldMinutes} minutes to keep ${pet.name}'s slot on ${date}.`, href: `/account/bookings/${booking.id}` });
      else notify(userId, { kind: "booking", title: booking.status === "confirmed" ? "Booking confirmed" : "Booking received", message: `${pet.name}'s grooming #${booking.bookingNo} on ${date}.`, href: `/account/bookings/${booking.id}` });
      await notifyStaff(assigned, { title: "New appointment", message: `${pet.name} · #${booking.bookingNo} on ${date}.` });
      return booking;
    } catch (e) {
      if (!dupKey(e)) throw e;
      if (groomerId) throw conflict("That time was just taken. Please pick another slot.", "slot_unavailable");
    }
  }
  throw conflict("That time was just taken. Please pick another slot.", "slot_unavailable");
}

function generatePickup(booking) {
  const code = randomDigits(6);
  booking.pickup = { otpSealed: seal(Buffer.from(code)), generatedAt: new Date(), expiresAt: new Date(Date.now() + 48 * 3600_000), attempts: 0 };
  return code;
}

export async function setStatus(booking, next, { reason, actor } = {}) {
  if (!FORWARD[booking.status]?.includes(next)) throw conflict(`A ${LABEL[booking.status]} booking cannot become ${LABEL[next]}.`, "bad_transition");
  const previous = booking.status;
  await withTxn(async (session) => {
    if (next === "cancelled" || next === "no_show") await release(booking, session);
    booking.status = next;
    booking.history.set(next, new Date());
    if (next === "cancelled") {
      booking.cancelReason = reason;
      if (booking.advance?.status === "due") booking.advance.status = "expired";
      if (booking.pickDrop?.stage && !["delivered", "cancelled"].includes(booking.pickDrop.stage)) {
        booking.pickDrop.stage = "cancelled";
        booking.pickDrop.history.set("cancelled", new Date());
      }
    }
    if (next === "ready_for_pickup") generatePickup(booking);
    await booking.save({ session });
    if (next === "no_show") await User.updateOne({ _id: booking.userId }, { $inc: { noShowCount: 1 } }, { session });
  });

  // A cancelled booking returns the booking amount. A no-show keeps it.
  if (next === "cancelled" && booking.advance?.status === "paid") await refundAdvance(booking, reason);

  const homeDrop = Boolean(booking.pickDrop?.drop) && booking.pickDrop.stage !== "cancelled";
  const title = next === "ready_for_pickup" ? (homeDrop ? "Your pet is ready to come home" : "Your pet is ready for pickup") : `Booking ${LABEL[next]}`;
  const message =
    next === "ready_for_pickup"
      ? homeDrop
        ? `Our team will bring them home. Share the OTP on booking #${booking.bookingNo} only when your pet is handed over.`
        : `Open booking #${booking.bookingNo} and show the pickup OTP at the store.`
      : `Booking #${booking.bookingNo} is now ${LABEL[next]}.`;
  notify(booking.userId, { kind: "booking", title, message, href: `/account/bookings/${booking.id}` });
  if (next === "cancelled" || previous === "pending") await notifyStaff(booking.groomerId, { title: `Appointment ${LABEL[next]}`, message: `#${booking.bookingNo} on ${booking.date}.${actor ? ` Updated by ${actor}.` : ""}` });
  return booking;
}

/** Moves a booking and/or changes its groomer. The new slot is held before the old one is given up, in one transaction. */
export async function moveBooking(booking, { date = booking.date, start = booking.start, groomerId }) {
  const target = groomerId ?? String(booking.groomerId);
  const sameSlot = date === booking.date && start === booking.start && target === String(booking.groomerId);
  if (sameSlot) return booking;
  if (!(await slotIsOpen(date, start, booking.duration))) throw conflict("That time is not available.", "slot_unavailable");
  if (!(await groomerCanWork(target, date, start, booking.duration))) throw conflict("That groomer is not working at this time.", "slot_unavailable");

  const oldGroomer = booking.groomerId;
  const changed = target !== String(oldGroomer);
  try {
    await withTxn(async (session) => {
      await release({ _id: booking._id, date: booking.date }, session);
      booking.date = date;
      booking.start = start;
      booking.groomerId = target;
      if (changed) booking.acknowledgedAt = undefined;
      await booking.save({ session });
      await reserve(booking, session);
    });
  } catch (e) {
    if (dupKey(e)) throw conflict("That time was just taken. Please pick another slot.", "slot_unavailable");
    throw e;
  }
  notify(booking.userId, { kind: "booking", title: "Booking updated", message: `#${booking.bookingNo} is now on ${date}.`, href: `/account/bookings/${booking.id}` });
  await notifyStaff(target, { title: changed ? "New appointment" : "Appointment changed", message: `#${booking.bookingNo} on ${date}.` });
  if (changed) await notifyStaff(oldGroomer, { title: "Appointment reassigned", message: `#${booking.bookingNo} moved to another groomer.` });
  return booking;
}

export async function customerMayChange(booking) {
  const settings = await getSettings();
  const cutoff = storeInstant(booking.date, booking.start).getTime() - settings.cancelCutoffHours * 3600_000;
  if (!["pending", "confirmed", "scheduled"].includes(booking.status)) throw conflict("This booking can no longer be changed.", "bad_transition");
  if (Date.now() > cutoff) throw conflict(`Bookings can be changed up to ${settings.cancelCutoffHours} hours before the slot. Please call the store.`, "too_late");
}

const loadWithOtp = (id) => Booking.findById(id).select("+pickup.otpSealed");

export function pickupCode(booking) {
  if (booking.status !== "ready_for_pickup" || !booking.pickup?.otpSealed) return null;
  return unseal(booking.pickup.otpSealed).toString();
}

/** Pickup completes only with the customer's OTP. Five wrong codes void it until the store issues a new one. */
export async function verifyPickup(id, code, actor) {
  const booking = await loadWithOtp(id);
  if (!booking) throw notFound("Booking not found.");
  if (booking.status !== "ready_for_pickup") throw conflict("This pet is not ready for pickup.", "bad_transition");
  const p = booking.pickup;
  if (!p?.otpSealed || p.expiresAt < new Date()) throw conflict("This OTP has expired. Generate a new one.", "otp_expired");
  if (p.attempts >= 5) throw conflict("Too many wrong codes. Generate a new OTP.", "otp_locked");
  if (!safeEqual(unseal(p.otpSealed).toString(), code)) {
    await Booking.updateOne({ _id: id }, { $inc: { "pickup.attempts": 1 } });
    throw badRequest("Wrong OTP.", "wrong_otp");
  }
  booking.status = "picked_up";
  booking.history.set("picked_up", new Date());
  booking.pickup.otpSealed = undefined;
  booking.pickup.verifiedAt = new Date();
  booking.pickup.verifiedBy = actor._id;
  booking.pickup.verifiedByName = actor.name;
  // Handed over at home by the pick & drop staff.
  if (booking.pickDrop?.stage === "out_for_drop") {
    booking.pickDrop.stage = "delivered";
    booking.pickDrop.history.set("delivered", new Date());
  }
  await booking.save();
  notify(booking.userId, { kind: "booking", title: "Pet picked up", message: `Thanks for visiting! Booking #${booking.bookingNo} is complete.`, href: `/account/bookings/${booking.id}` });
  return booking;
}

export async function regeneratePickup(id) {
  const booking = await loadWithOtp(id);
  if (!booking) throw notFound("Booking not found.");
  if (booking.status !== "ready_for_pickup") throw conflict("This pet is not ready for pickup.", "bad_transition");
  generatePickup(booking);
  await booking.save();
  notify(booking.userId, { kind: "booking", title: "New pickup OTP", message: `A new pickup OTP was issued for #${booking.bookingNo}.`, href: `/account/bookings/${booking.id}` });
  return booking;
}

