import { withTxn } from "../config/db.js";
import { Booking, Coupon, Invoice, Order, Product, StockLog } from "../models/index.js";
import { badRequest, conflict, notFound } from "./errors.js";
import { getSettings, nextSeq, notify, storeNow } from "./misc.js";
import { billTotals, statusFromPayments } from "./money.js";

/* ---------- Stock. Conditional updates make overselling impossible under concurrent orders. ---------- */

export async function takeStock(productId, qty, reason, refId, by, session) {
  const res = await Product.updateOne({ _id: productId, stock: { $gte: qty } }, { $inc: { stock: -qty } }, { session });
  if (!res.modifiedCount) {
    const p = await Product.findById(productId).select("name stock").session(session).lean();
    throw conflict(p ? `Only ${p.stock} of ${p.name} left in stock.` : "Product not found.", "out_of_stock");
  }
  await StockLog.create([{ productId, change: -qty, reason, refId, by }], { session });
}

export async function returnStock(productId, qty, refId, note, by, session) {
  await Product.updateOne({ _id: productId }, { $inc: { stock: qty } }, { session });
  await StockLog.create([{ productId, change: qty, reason: "cancel", refId, note, by }], { session });
}

/* ---------- Coupons ---------- */

export async function checkCoupon(code, subtotal) {
  const c = await Coupon.findOne({ code: String(code).toUpperCase().trim(), active: true }).lean();
  const today = storeNow().date;
  if (!c || (c.startDate && today < c.startDate) || (c.endDate && today > c.endDate)) throw badRequest("This coupon isn't valid.", "bad_coupon");
  if (c.usageLimit && c.used >= c.usageLimit) throw badRequest("This coupon has been used up.", "bad_coupon");
  if (subtotal < (c.minAmount ?? 0)) throw badRequest(`Add items worth ₹${c.minAmount} or more to use this coupon.`, "bad_coupon");
  return { coupon: c, discount: c.type === "percent" ? Math.round((subtotal * c.value) / 100) : Math.min(c.value, subtotal) };
}

async function useCoupon(id, session) {
  const res = await Coupon.updateOne({ _id: id, $or: [{ usageLimit: 0 }, { $expr: { $lt: ["$used", "$usageLimit"] } }] }, { $inc: { used: 1 } }, { session });
  if (!res.modifiedCount) throw badRequest("This coupon has been used up.", "bad_coupon");
}

/* ---------- Orders. Prices, charges and discounts always come from the database, never from the browser. ---------- */

const NEXT = {
  placed: ["confirmed", "cancelled"],
  confirmed: ["packed", "cancelled"],
  packed: ["out_for_delivery", "ready_for_pickup", "cancelled"],
  out_for_delivery: ["delivered"],
  ready_for_pickup: ["delivered", "cancelled"],
};

const LABEL = { placed: "placed", confirmed: "confirmed", packed: "packed", out_for_delivery: "out for delivery", ready_for_pickup: "ready for pickup", delivered: "delivered", cancelled: "cancelled" };

export async function placeOrder(user, { items, fulfilment, payment, addressId, couponCode }) {
  const settings = await getSettings();
  const merged = new Map();
  for (const i of items) {
    const key = `${i.productId}|${i.variantId}`;
    merged.set(key, { ...i, qty: (merged.get(key)?.qty ?? 0) + i.qty });
  }
  const ids = [...new Set(items.map((i) => i.productId))];
  const products = new Map((await Product.find({ _id: { $in: ids }, active: true }).lean()).map((p) => [String(p._id), p]));

  const lines = [...merged.values()].map((i) => {
    const p = products.get(i.productId);
    const v = p?.variants.find((x) => x.id === i.variantId);
    if (!p || !v) throw badRequest("A product in your cart is no longer available.", "item_unavailable");
    return { productId: p._id, variantId: v.id, name: p.name, variant: v.label, image: p.image, price: v.price, qty: i.qty, gstRate: p.gstRate, hsn: p.hsn };
  });

  let address;
  let snapshot;
  if (fulfilment === "delivery") {
    const a = user.addresses.id(addressId);
    if (!a) throw badRequest("Choose a delivery address.");
    if (!settings.deliveryPincodes.includes(a.pincode)) throw badRequest("We don't deliver to this pincode yet. Choose store pickup instead.", "no_delivery");
    snapshot = a;
    address = [a.line1, a.line2, a.city, a.pincode, a.state].filter(Boolean).join(", ");
  }

  const subtotal = lines.reduce((s, l) => s + l.price * l.qty, 0);
  const deliveryCharge = fulfilment === "delivery" && subtotal < settings.freeDeliveryAbove ? settings.deliveryCharge : 0;
  const applied = couponCode ? await checkCoupon(couponCode, subtotal) : null;
  const discount = applied?.discount ?? 0;
  if (payment === "COD" && subtotal + deliveryCharge - discount > settings.codLimit) throw badRequest(`Cash on Delivery is available up to ₹${settings.codLimit}.`, "cod_limit");

  const order = await withTxn(async (session) => {
    const seq = await nextSeq("order", 10235, session);
    const orderNo = `PSO${seq}`;
    const [doc] = await Order.create(
      [{ orderNo, userId: user._id, items: lines, fulfilment, payment, deliveryCharge, discount, couponCode: applied?.coupon.code, address, addressId: snapshot?.id, history: { placed: new Date() } }],
      { session },
    );
    if (applied) await useCoupon(applied.coupon._id, session);
    const byProduct = new Map();
    for (const l of lines) byProduct.set(String(l.productId), (byProduct.get(String(l.productId)) ?? 0) + l.qty);
    for (const [productId, qty] of byProduct) await takeStock(productId, qty, "sale", doc.id, user._id, session);
    return doc;
  });
  notify(user._id, { kind: "order", title: "Order placed", message: `Order #${order.orderNo} has been placed.`, href: `/account/orders/${order.id}` });
  return order;
}

export async function setOrderStatus(order, next, { reason, by } = {}) {
  if (!NEXT[order.status]?.includes(next)) throw conflict(`An order that is ${LABEL[order.status]} cannot become ${LABEL[next]}.`, "bad_transition");
  if (next === "out_for_delivery" && order.fulfilment !== "delivery") throw conflict("This order is for pickup.", "bad_transition");
  if (next === "ready_for_pickup" && order.fulfilment === "delivery") throw conflict("This order is for home delivery.", "bad_transition");
  await withTxn(async (session) => {
    order.status = next;
    order.history.set(next, new Date());
    if (next === "cancelled") {
      order.cancelReason = reason;
      const byProduct = new Map();
      for (const l of order.items) byProduct.set(String(l.productId), (byProduct.get(String(l.productId)) ?? 0) + l.qty);
      for (const [productId, qty] of byProduct) await returnStock(productId, qty, order.id, `Order #${order.orderNo} cancelled`, by, session);
    }
    await order.save({ session });
  });
  notify(order.userId, { kind: "order", title: `Order ${LABEL[next]}`, message: `Order #${order.orderNo} is ${LABEL[next]}.`, href: `/account/orders/${order.id}` });
  return order;
}

/* ---------- Billing ---------- */

/** Quantities the bill itself must take from stock. An online order already took its own items when it was placed. */
function stockDelta(items, order) {
  const billed = new Map();
  for (const i of items) if (i.kind === "product" && i.refId) billed.set(i.refId, (billed.get(i.refId) ?? 0) + i.qty);
  if (order) for (const l of order.items) billed.set(String(l.productId), (billed.get(String(l.productId)) ?? 0) - l.qty);
  return [...billed.entries()].filter(([, qty]) => qty > 0);
}

export async function createInvoice(draft, actor) {
  const settings = await getSettings();
  return withTxn(async (session) => {
    const { source, couponId } = draft;
    let order = null;
    if (source.type === "booking") {
      const res = await Booking.updateOne({ _id: source.refId, $or: [{ invoiceId: null }, { invoiceId: { $exists: false } }], status: { $nin: ["cancelled", "no_show"] } }, { $set: { invoiceId: draft._id } }, { session });
      if (!res.modifiedCount) throw conflict("This booking already has a bill.", "already_billed");
    }
    if (source.type === "order") {
      order = await Order.findOneAndUpdate({ _id: source.refId, $or: [{ invoiceId: null }, { invoiceId: { $exists: false } }], status: { $ne: "cancelled" } }, { $set: { invoiceId: draft._id } }, { session, returnDocument: "after" }).lean();
      if (!order) throw conflict("This order already has a bill.", "already_billed");
    }

    const seq = await nextSeq("invoice", 10300, session);
    const at = new Date();
    const payments = draft.payments.filter((p) => p.amount > 0).map((p) => ({ ...p, at }));
    const bill = { items: draft.items, discountPercent: draft.discountPercent, discountFlat: draft.discountFlat, gstEnabled: settings.gstEnabled, payments };
    const totals = billTotals(bill);
    if (totals.paid > totals.total + 0.005) throw badRequest("Payment is more than the bill total.");

    const [invoice] = await Invoice.create(
      [{ ...bill, _id: draft._id, invoiceNo: `${settings.invoicePrefix}${seq}`, date: at, userId: draft.customerId ?? undefined, customerName: draft.customerName, customerPhone: draft.customerPhone, petName: draft.petName, source, discountLabel: draft.discountLabel, status: statusFromPayments(totals.total, totals.paid), createdBy: actor._id }],
      { session },
    );
    for (const [productId, qty] of stockDelta(draft.items, order)) await takeStock(productId, qty, "sale", invoice.id, actor._id, session);
    if (couponId) await useCoupon(couponId, session);
    return invoice;
  });
}

export async function addPayment(id, payment) {
  const invoice = await Invoice.findById(id);
  if (!invoice) throw notFound("Bill not found.");
  if (invoice.status === "cancelled" || invoice.status === "paid") throw conflict("This bill can't take a payment.", "bad_transition");
  const t = billTotals(invoice.toObject());
  if (payment.amount > t.due + 0.005) throw badRequest(`Only ₹${t.due} is due on this bill.`);
  invoice.payments.push({ ...payment, at: new Date() });
  invoice.status = statusFromPayments(t.total, t.paid + payment.amount);
  await invoice.save();
  return invoice;
}

/** Bills are never deleted (BRD §7.4). Cancelling keeps the record and frees the source for a corrected bill. */
export async function cancelInvoice(id, reason, actor) {
  return withTxn(async (session) => {
    const invoice = await Invoice.findById(id).session(session);
    if (!invoice) throw notFound("Bill not found.");
    if (invoice.status === "cancelled") throw conflict("This bill is already cancelled.", "bad_transition");
    const order = invoice.source?.type === "order" ? await Order.findById(invoice.source.refId).session(session).lean() : null;
    for (const [productId, qty] of stockDelta(invoice.items, order)) await returnStock(productId, qty, invoice.id, `Bill #${invoice.invoiceNo} cancelled`, actor._id, session);
    invoice.status = "cancelled";
    invoice.cancelReason = reason;
    await invoice.save({ session });
    await Booking.updateMany({ invoiceId: invoice._id }, { $unset: { invoiceId: 1 } }, { session });
    await Order.updateMany({ invoiceId: invoice._id }, { $unset: { invoiceId: 1 } }, { session });
    return invoice;
  });
}

