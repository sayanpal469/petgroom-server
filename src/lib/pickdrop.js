import { effectivePermissions } from "../config/permissions.js";
import { Booking, Pet, User } from "../models/index.js";
import { setStatus, verifyPickup } from "./bookings.js";
import { randomDigits, safeEqual, seal, unseal } from "./crypto.js";
import { badRequest, conflict, forbidden, notFound } from "./errors.js";
import { notify } from "./misc.js";

/**
 * Pick & drop trips ride on a booking. Stages:
 *   requested → assigned → collected → at_store → out_for_drop → delivered
 * A booking with only a drop skips collected/at_store; one with only a pickup ends at at_store.
 * The pet leaves the customer only against the collect OTP, and comes back only against the
 * booking's pickup OTP, so it is always handed to the right person.
 */

export const STAGE_LABEL = { requested: "requested", assigned: "assigned", collected: "picked up from home", at_store: "at the store", out_for_drop: "on the way home", delivered: "dropped home", cancelled: "cancelled" };

const loadTrip = async (id, withOtp = false) => {
  const q = Booking.findById(id);
  const b = await (withOtp ? q.select("+pickDrop.collectOtpSealed") : q);
  if (!b?.pickDrop?.stage) throw notFound("Trip not found.");
  return b;
};

const stamp = (b, stage) => {
  b.pickDrop.stage = stage;
  b.pickDrop.history.set(stage, new Date());
};

/** The collect OTP is shown to the customer while the driver is on the way to pick up. */
export function collectCode(b) {
  if (b.pickDrop?.stage !== "assigned" || !b.pickDrop.pickup || !b.pickDrop.collectOtpSealed) return null;
  return unseal(b.pickDrop.collectOtpSealed).toString();
}

export async function assignTrip(id, { staffId, window }) {
  const b = await loadTrip(id);
  if (["delivered", "cancelled"].includes(b.pickDrop.stage)) throw conflict("This trip is closed.", "bad_transition");
  if (["cancelled", "no_show", "picked_up"].includes(b.status)) throw conflict("This booking is closed.", "bad_transition");
  const staff = await User.findOne({ _id: staffId, status: "active", role: { $ne: "customer" } });
  if (!staff || !effectivePermissions(staff).includes("pickdrop.own")) throw badRequest("Choose someone with pick & drop access.");
  const previous = b.pickDrop.staffId ? String(b.pickDrop.staffId) : null;
  b.pickDrop.staffId = staff._id;
  b.pickDrop.staffName = staff.name;
  b.pickDrop.window = window || undefined;
  if (b.pickDrop.stage === "requested") {
    stamp(b, "assigned");
    if (b.pickDrop.pickup) {
      b.pickDrop.collectOtpSealed = seal(Buffer.from(randomDigits(6)));
      b.pickDrop.collectAttempts = 0;
    }
  }
  await b.save();
  const pet = await Pet.findById(b.petId).select("name").lean();
  notify(staff._id, { kind: "assignment", title: "New pick & drop trip", message: `${pet?.name ?? "Pet"} · #${b.bookingNo} on ${b.date}${window ? ` (${window})` : ""}.`, href: "/trips" });
  if (previous && previous !== String(staff._id)) notify(previous, { kind: "assignment", title: "Trip reassigned", message: `#${b.bookingNo} moved to ${staff.name}.`, href: "/trips" });
  notify(b.userId, {
    kind: "booking",
    title: "Pick & drop scheduled",
    message: `${staff.name} will handle ${pet?.name ?? "your pet"}'s ${b.pickDrop.pickup ? "pickup" : "drop"}${window ? ` (${window})` : ""}.${b.pickDrop.pickup ? " Share the pickup code only when handing over your pet." : ""}`,
    href: `/account/bookings/${b.id}`,
  });
  return b;
}

const NEXT = {
  collected: (b) => b.pickDrop.stage === "assigned" && Boolean(b.pickDrop.pickup),
  at_store: (b) => b.pickDrop.stage === "collected",
  out_for_drop: (b) => Boolean(b.pickDrop.drop) && (b.pickDrop.stage === "at_store" || (b.pickDrop.stage === "assigned" && !b.pickDrop.pickup)),
  delivered: (b) => b.pickDrop.stage === "out_for_drop",
};

/** Moves a trip one stage. Only the assigned staff member, or someone who manages trips, may do it. */
export async function stepTrip(id, { step, code }, actor, canManage) {
  const b = await loadTrip(id, step === "collected");
  if (!canManage && String(b.pickDrop.staffId) !== String(actor._id)) throw forbidden("This trip isn't assigned to you.");
  if (!NEXT[step]?.(b)) throw conflict(`This trip is ${STAGE_LABEL[b.pickDrop.stage]} and can't be marked ${STAGE_LABEL[step]}.`, "bad_transition");

  if (step === "collected") {
    if ((b.pickDrop.collectAttempts ?? 0) >= 5) throw conflict("Too many wrong codes. Ask the store to issue a new one.", "otp_locked");
    if (!code || !b.pickDrop.collectOtpSealed || !safeEqual(unseal(b.pickDrop.collectOtpSealed).toString(), code)) {
      await Booking.updateOne({ _id: b._id }, { $inc: { "pickDrop.collectAttempts": 1 } });
      throw badRequest("Wrong code. Ask the customer for the pickup code on their booking.", "wrong_otp");
    }
    b.pickDrop.collectOtpSealed = undefined;
  }
  if (step === "out_for_drop" && b.status !== "ready_for_pickup") throw conflict("Mark the grooming ready for pickup first.", "bad_transition");
  if (step === "delivered") {
    if (!code) throw badRequest("Enter the customer's OTP.", "wrong_otp");
    // The booking's pickup OTP closes both the trip and the booking.
    return { booking: await verifyPickup(b.id, code, actor) };
  }

  stamp(b, step);
  await b.save();
  // Arriving at the store checks the pet in, the same as a walk-in drop-off.
  if (step === "at_store" && ["confirmed", "scheduled"].includes(b.status)) await setStatus(b, "checked_in", { actor: actor.name });

  const pet = await Pet.findById(b.petId).select("name").lean();
  notify(b.userId, { kind: "booking", title: `${pet?.name ?? "Your pet"} is ${STAGE_LABEL[step]}`, message: `Booking #${b.bookingNo}.`, href: `/account/bookings/${b.id}` });
  return { booking: b };
}

/** Issues a new collect code, for example after five wrong attempts. */
export async function newCollectCode(id) {
  const b = await loadTrip(id, true);
  if (b.pickDrop.stage !== "assigned" || !b.pickDrop.pickup) throw conflict("This trip has no pickup waiting.", "bad_transition");
  b.pickDrop.collectOtpSealed = seal(Buffer.from(randomDigits(6)));
  b.pickDrop.collectAttempts = 0;
  await b.save();
  notify(b.userId, { kind: "booking", title: "New pickup code", message: `A new pickup code was issued for #${b.bookingNo}.`, href: `/account/bookings/${b.id}` });
  return b;
}
