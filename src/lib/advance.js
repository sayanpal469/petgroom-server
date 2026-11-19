import { Booking, User } from "../models/index.js";
import { badRequest, conflict } from "./errors.js";
import { logger } from "./logger.js";
import { getSettings, notify } from "./misc.js";
import { capturePayment, createOrder, fetchPayment, getPayConfig, orderPayments, payReady, refundPayment, signatureValid } from "./payments.js";

/**
 * The booking amount: a part of the grooming price paid online to hold the slot. The slot is held
 * while the customer pays; an unpaid booking is cancelled after `advanceHoldMinutes` by the jobs.
 * The amount paid is added to the booking's bill as an "Online" payment.
 */

export function advanceFor(settings, total) {
  if (!settings.advanceEnabled || total <= 0) return 0;
  const raw = settings.advanceType === "percent" ? Math.round((total * settings.advanceValue) / 100) : settings.advanceValue;
  return Math.max(0, Math.min(Math.round(raw), Math.round(total)));
}

/** Online bookings pay the booking amount only when the store turned it on and the gateway is ready. */
export async function advanceNeeded(total) {
  const [settings, pay] = await Promise.all([getSettings(), getPayConfig()]);
  if (!payReady(pay)) return 0;
  return advanceFor(settings, total);
}

/** What the browser needs to open Razorpay Checkout. Reuses the order already created for this booking. */
export async function checkoutFor(booking, user) {
  const a = booking.advance;
  if (!a?.amount || a.status !== "due") throw conflict("Nothing to pay on this booking.", "nothing_due");
  if (booking.status === "cancelled") throw conflict("This booking was cancelled.", "bad_transition");
  const pay = await getPayConfig();
  if (!payReady(pay)) throw conflict("Online payment is switched off. Please call the store.", "payment_unavailable");
  if (!a.orderId) {
    const order = await createOrder(pay, { amount: Math.round(a.amount * 100), receipt: booking.bookingNo, notes: { bookingId: booking.id, bookingNo: booking.bookingNo } });
    a.orderId = order.id;
    await Booking.updateOne({ _id: booking._id, "advance.orderId": { $exists: false } }, { $set: { "advance.orderId": order.id } });
  }
  const settings = await getSettings();
  return {
    keyId: pay.keyId,
    orderId: a.orderId,
    amount: Math.round(a.amount * 100),
    currency: "INR",
    name: settings.storeName,
    description: `Booking amount · #${booking.bookingNo}`,
    dueBy: a.dueBy?.toISOString(),
    prefill: { name: user.name === "New Customer" ? "" : user.name, contact: user.phone ? `+91${user.phone}` : "", email: user.email ?? "" },
  };
}

/** Marks the advance paid once. A payment that lands after the booking was cancelled is refunded at once. */
async function markPaid(booking, payment) {
  const settings = await getSettings();
  const paidAt = new Date((payment.created_at ?? Date.now() / 1000) * 1000);
  const res = await Booking.updateOne(
    { _id: booking._id, "advance.status": { $in: ["due", "expired"] } },
    { $set: { "advance.status": "paid", "advance.paymentId": payment.id, "advance.method": payment.method, "advance.paidAt": paidAt } },
  );
  const fresh = await Booking.findById(booking._id);
  if (!res.modifiedCount) return fresh;

  if (fresh.status === "cancelled") {
    await refundAdvance(fresh, "Booking was cancelled before the payment arrived");
    return fresh;
  }
  if (fresh.status === "pending" && settings.autoConfirm) {
    fresh.status = "confirmed";
    fresh.history.set("confirmed", new Date());
    await fresh.save();
  }
  notify(fresh.userId, {
    kind: "booking",
    title: fresh.status === "confirmed" ? "Booking confirmed" : "Booking amount received",
    message: `₹${fresh.advance.amount} received for booking #${fresh.bookingNo}. The rest is paid at the store.`,
    href: `/account/bookings/${fresh.id}`,
  });
  return fresh;
}

/** Checks a payment Razorpay reports for this booking's order, captures it if needed, and records it. */
async function settle(pay, booking, payment) {
  if (payment.order_id !== booking.advance.orderId) throw badRequest("This payment is for another order.", "payment_mismatch");
  if (payment.amount !== Math.round(booking.advance.amount * 100)) throw badRequest("The amount paid doesn't match.", "payment_mismatch");
  let p = payment;
  if (p.status === "authorized") p = await capturePayment(pay, p.id, p.amount);
  if (p.status !== "captured") throw badRequest("The payment didn't go through. Please try again.", "payment_failed");
  return markPaid(booking, p);
}

/** Called by the browser after Checkout succeeds. The signature proves Razorpay sent it. */
export async function verifyAdvance(booking, { orderId, paymentId, signature }) {
  const pay = await getPayConfig();
  if (!booking.advance?.orderId || booking.advance.orderId !== orderId) throw badRequest("This payment is for another booking.", "payment_mismatch");
  if (booking.advance.status === "paid") return booking;
  if (!signatureValid(pay, orderId, paymentId, signature)) throw badRequest("We couldn't verify this payment. If money was taken, it will be matched shortly.", "payment_unverified");
  return settle(pay, booking, await fetchPayment(pay, paymentId));
}

/** Looks for a payment Razorpay received but the browser never reported (closed tab, lost network). */
export async function reconcileAdvance(booking) {
  if (!booking.advance?.orderId || !["due", "expired"].includes(booking.advance.status)) return booking;
  const pay = await getPayConfig();
  if (!pay.keyId || !pay.secretSealed) return booking;
  const payments = await orderPayments(pay, booking.advance.orderId);
  const good = payments.find((p) => p.status === "captured") ?? payments.find((p) => p.status === "authorized");
  if (!good) return booking;
  return settle(pay, booking, good);
}

/** Full refund of the booking amount. A failure is kept on the booking so the store can retry. */
export async function refundAdvance(booking, reason) {
  const a = booking.advance;
  if (a?.status !== "paid" && a?.status !== "refund_failed") return booking;
  const pay = await getPayConfig();
  try {
    const refund = await refundPayment(pay, a.paymentId, Math.round(a.amount * 100), { bookingNo: booking.bookingNo, reason: String(reason ?? "").slice(0, 200) });
    await Booking.updateOne({ _id: booking._id }, { $set: { "advance.status": "refunded", "advance.refundId": refund.id, "advance.refundedAt": new Date() }, $unset: { "advance.refundError": 1 } });
    booking.advance.status = "refunded";
    booking.advance.refundId = refund.id;
    notify(booking.userId, { kind: "booking", title: "Booking amount refunded", message: `₹${a.amount} for #${booking.bookingNo} is on its way back to you. Banks take 5–7 working days.`, href: `/account/bookings/${booking.id}` });
  } catch (err) {
    logger.error({ err, booking: booking.bookingNo }, "advance refund failed");
    await Booking.updateOne({ _id: booking._id }, { $set: { "advance.status": "refund_failed", "advance.refundError": String(err.message).slice(0, 200) } });
    booking.advance.status = "refund_failed";
    const admins = await User.find({ role: { $in: ["admin", "super_admin"] }, status: "active" }).select("_id").lean();
    for (const u of admins) notify(u._id, { kind: "booking", title: "Refund failed", message: `Refund for #${booking.bookingNo} failed. Open the booking to retry.`, href: `/bookings?open=${booking.id}` });
  }
  return booking;
}
