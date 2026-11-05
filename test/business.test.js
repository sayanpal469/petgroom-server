import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { Client, boot, fixture, loginCustomer, loginPanel, shutdown, tomorrow } from "./helpers.js";

let f;
before(boot);
after(shutdown);
beforeEach(async () => {
  f = await fixture();
});

const svc = () => [String(f.bath._id)];
const book = (c, pet, extra = {}) => c.post("/me/bookings", { petId: String(pet._id), serviceIds: svc(), date: tomorrow(2), start: 600, ...extra });

async function manyCustomers(n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const phone = `90000100${String(i).padStart(2, "0")}`;
    const user = await f.m.User.create({ role: "customer", name: `C${i}`, phone });
    const pet = await f.m.Pet.create({ userId: user._id, name: `P${i}`, type: "dog", size: "medium" });
    out.push({ client: await loginCustomer(phone), pet });
  }
  return out;
}

test("double booking: 12 customers race for one groomer's slot, exactly one wins", async () => {
  const people = await manyCustomers(12);
  const groomerId = String(f.groomers[0]._id);
  const results = await Promise.all(people.map((p) => book(p.client, p.pet, { groomerId })));
  const ok = results.filter((r) => r.status === 201);
  assert.equal(ok.length, 1, JSON.stringify(results.map((r) => r.status)));
  assert.ok(results.every((r) => r.status === 201 || r.status === 409), JSON.stringify(results.map((r) => [r.status, r.body])));
  assert.equal(await f.m.Booking.countDocuments({ groomerId }), 1);
});

test("capacity: 12 customers race on 'any groomer', only slot capacity get in", async () => {
  await f.m.Settings.updateOne({ _id: "store" }, { $set: { "data.slotCapacity": 2 } });
  const people = await manyCustomers(12);
  const results = await Promise.all(people.map((p) => book(p.client, p.pet)));
  assert.equal(results.filter((r) => r.status === 201).length, 2, JSON.stringify(results.map((r) => r.status)));
  const groomers = await f.m.Booking.distinct("groomerId");
  assert.equal(groomers.length, 2);
  assert.equal((await f.m.SlotLoad.findById(`${tomorrow(2)}|600`).lean()).count, 2);
});

test("a long booking occupies every slot step it covers", async () => {
  const riya = await loginCustomer("9876543210");
  const g = String(f.groomers[0]._id);
  await riya.post("/me/bookings", { petId: String(f.riyaPet._id), serviceIds: [String(f.cut._id)], date: tomorrow(2), start: 600, groomerId: g });
  const sam = await loginCustomer("9876543211");
  assert.equal((await book(sam, f.samPet, { groomerId: g, start: 630 })).status, 409);
  assert.equal((await book(sam, f.samPet, { groomerId: g, start: 660 })).status, 201);
});

test("cancelling frees the slot and the capacity", async () => {
  const riya = await loginCustomer("9876543210");
  const g = String(f.groomers[0]._id);
  const { body } = await book(riya, f.riyaPet, { groomerId: g });
  await riya.post(`/me/bookings/${body.booking.id}/cancel`);
  assert.equal(await f.m.SlotHold.countDocuments({}), 0);
  assert.equal((await f.m.SlotLoad.findById(`${tomorrow(2)}|600`).lean()).count, 0);
  const sam = await loginCustomer("9876543211");
  assert.equal((await book(sam, f.samPet, { groomerId: g })).status, 201);
});

test("automatic confirmation, unique IDs and customer notification", async () => {
  const riya = await loginCustomer("9876543210");
  const a = await book(riya, f.riyaPet);
  const b = await book(riya, f.riyaPet, { start: 720 });
  assert.equal(a.body.booking.status, "confirmed");
  assert.notEqual(a.body.booking.bookingNo, b.body.booking.bookingNo);
  await new Promise((r) => setTimeout(r, 100));
  assert.ok((await riya.get("/me/bootstrap")).body.notifications.length >= 1);
});

test("workload-based assignment spreads bookings across groomers", async () => {
  const riya = await loginCustomer("9876543210");
  const one = await book(riya, f.riyaPet, { start: 600 });
  const two = await book(riya, f.riyaPet, { start: 720 });
  assert.notEqual(one.body.booking.groomerId, two.body.booking.groomerId);
});

test("holidays, closed days, blocks, leave and past times cannot be booked", async () => {
  const sup = await loginPanel("super@t.in");
  const riya = await loginCustomer("9876543210");
  const date = tomorrow(5);
  await sup.put("/panel/settings", { holidays: [date] });
  assert.equal((await book(riya, f.riyaPet, { date })).status, 409);
  await sup.put("/panel/settings", { holidays: [] });

  await sup.post("/panel/blocks", { date, start: 540, end: 720, reason: "Maintenance" });
  assert.equal((await book(riya, f.riyaPet, { date, start: 600 })).status, 409);
  assert.equal((await book(riya, f.riyaPet, { date, start: 720 })).status, 201);

  const q = `date=${date}&serviceIds=${f.bath._id}&size=large`;
  const { body } = await new Client().get(`/public/slots?${q}`);
  assert.equal(body.slots.find((s) => s.minutes === 600).available, false);
  assert.equal(body.slots.find((s) => s.minutes === 780).available, true);

  await f.m.Groomer.updateMany({}, { $set: { leaveDays: [tomorrow(6)] } });
  assert.equal((await book(riya, f.riyaPet, { date: tomorrow(6) })).status, 409);
  assert.equal((await book(riya, f.riyaPet, { date: "2020-01-01" })).status, 400);
});

test("reschedule moves the hold; a clash leaves the original booking intact", async () => {
  const riya = await loginCustomer("9876543210");
  const sam = await loginCustomer("9876543211");
  const g = String(f.groomers[0]._id);
  const a = await book(riya, f.riyaPet, { groomerId: g, start: 600 });
  await book(sam, f.samPet, { groomerId: g, start: 720 });
  const clash = await riya.post(`/me/bookings/${a.body.booking.id}/reschedule`, { date: tomorrow(2), start: 720 });
  assert.equal(clash.status, 409);
  const still = await riya.get(`/me/bookings/${a.body.booking.id}`);
  assert.equal(still.body.booking.startMinutes, 600);
  assert.equal(await f.m.SlotHold.countDocuments({ bookingId: a.body.booking.id, minute: 600 }), 1);

  assert.equal((await riya.post(`/me/bookings/${a.body.booking.id}/reschedule`, { date: tomorrow(2), start: 900 })).status, 200);
  assert.equal(await f.m.SlotHold.countDocuments({ bookingId: a.body.booking.id, minute: 900 }), 1);
  assert.equal(await f.m.SlotHold.countDocuments({ bookingId: a.body.booking.id, minute: 600 }), 0);
});

test("reassigning a groomer notifies both staff and requires a fresh acknowledgement", async () => {
  const riya = await loginCustomer("9876543210");
  const a = await book(riya, f.riyaPet, { groomerId: String(f.groomers[0]._id) });
  const id = a.body.booking.id;
  const staff = await loginPanel("staff@t.in");
  await staff.post(`/panel/work/${id}/ack`);
  const admin = await loginPanel("admin@t.in");
  const moved = await admin.post(`/panel/bookings/${id}/move`, { groomerId: String(f.groomers[1]._id) });
  assert.equal(moved.body.booking.groomerId, String(f.groomers[1]._id));
  assert.equal(moved.body.booking.acknowledgedAt, undefined);
  await new Promise((r) => setTimeout(r, 100));
  const staff2 = await loginPanel("staff2@t.in");
  assert.ok((await staff2.get("/panel/auth/notifications")).body.notifications.some((n) => n.title === "New appointment"));
  assert.ok((await staff.get("/panel/auth/notifications")).body.notifications.some((n) => n.title === "Appointment reassigned"));
});

test("full grooming lifecycle with OTP pickup and booking slip", async () => {
  const riya = await loginCustomer("9876543210");
  const { body } = await book(riya, f.riyaPet, { groomerId: String(f.groomers[0]._id) });
  const id = body.booking.id;
  const staff = await loginPanel("staff@t.in");
  assert.equal((await staff.post(`/panel/work/${id}/status`, { status: "completed" })).status, 409);
  for (const s of ["checked_in", "grooming_started", "in_progress", "completed", "ready_for_pickup"]) assert.equal((await staff.post(`/panel/work/${id}/status`, { status: s })).status, 200, s);

  const otp = (await riya.get(`/me/bookings/${id}`)).body.booking.pickupOtp;
  assert.equal((await staff.post(`/panel/work/${id}/pickup`, { code: otp === "000000" ? "000001" : "000000" })).status, 400);
  const done = await staff.post(`/panel/work/${id}/pickup`, { code: otp });
  assert.equal(done.body.booking.status, "picked_up");
  assert.equal(done.body.booking.pickup.verifiedByName, "staff");
  const after = (await riya.get(`/me/bookings/${id}`)).body.booking;
  assert.equal(after.pickupOtp, undefined);
  assert.ok(after.pickedUpAt);
  assert.ok(after.history.ready_for_pickup);

  const slip = await riya.get(`/me/bookings/${id}/slip`);
  assert.equal(Buffer.from(slip.body.base64, "base64").subarray(0, 4).toString(), "%PDF");
});

test("pickup OTP locks after five wrong codes until the store issues a new one", async () => {
  const riya = await loginCustomer("9876543210");
  const { body } = await book(riya, f.riyaPet);
  const id = body.booking.id;
  const admin = await loginPanel("admin@t.in");
  for (const s of ["checked_in", "grooming_started", "completed", "ready_for_pickup"]) await admin.post(`/panel/bookings/${id}/status`, { status: s });
  const otp = (await riya.get(`/me/bookings/${id}`)).body.booking.pickupOtp;
  const wrong = otp === "111111" ? "222222" : "111111";
  for (let i = 0; i < 5; i++) await admin.post(`/panel/bookings/${id}/pickup/verify`, { code: wrong });
  assert.equal((await admin.post(`/panel/bookings/${id}/pickup/verify`, { code: otp })).status, 409);
  await admin.post(`/panel/bookings/${id}/pickup/regenerate`);
  const next = (await riya.get(`/me/bookings/${id}`)).body.booking.pickupOtp;
  assert.equal((await admin.post(`/panel/bookings/${id}/pickup/verify`, { code: next })).status, 200);
});

test("pickup cannot be skipped by setting the status directly", async () => {
  const riya = await loginCustomer("9876543210");
  const { body } = await book(riya, f.riyaPet);
  const id = body.booking.id;
  const admin = await loginPanel("admin@t.in");
  for (const s of ["checked_in", "grooming_started", "completed", "ready_for_pickup"]) await admin.post(`/panel/bookings/${id}/status`, { status: s });
  assert.equal((await admin.post(`/panel/bookings/${id}/status`, { status: "picked_up" })).status, 409);
});

test("overselling: 10 customers race for 3 units, stock stops at zero", async () => {
  const people = await manyCustomers(10);
  const body = { items: [{ productId: String(f.food._id), variantId: "1kg", qty: 1 }], fulfilment: "pickup", payment: "PAY_AT_STORE" };
  const results = await Promise.all(people.map((p) => p.client.post("/me/orders", body)));
  assert.equal(results.filter((r) => r.status === 201).length, 3, JSON.stringify(results.map((r) => r.status)));
  assert.equal((await f.m.Product.findById(f.food._id).lean()).stock, 0);
  assert.equal(await f.m.StockLog.countDocuments({ productId: f.food._id, reason: "sale" }), 3);
});

test("a failed order rolls back completely: no stock change, no coupon use, no order", async () => {
  const riya = await loginCustomer("9876543210");
  const r = await riya.post("/me/orders", { items: [{ productId: String(f.food._id), variantId: "1kg", qty: 9 }], fulfilment: "pickup", payment: "PAY_AT_STORE", couponCode: "ONE" });
  assert.equal(r.status, 409);
  assert.equal((await f.m.Product.findById(f.food._id).lean()).stock, 3);
  assert.equal((await f.m.Coupon.findById(f.coupon._id).lean()).used, 0);
  assert.equal(await f.m.Order.countDocuments({}), 0);
});

test("a single-use coupon works once even when two orders race", async () => {
  await f.m.Product.updateOne({ _id: f.food._id }, { $set: { stock: 50 } });
  const people = await manyCustomers(6);
  const body = { items: [{ productId: String(f.food._id), variantId: "1kg", qty: 1 }], fulfilment: "pickup", payment: "PAY_AT_STORE", couponCode: "ONE" };
  const results = await Promise.all(people.map((p) => p.client.post("/me/orders", body)));
  assert.equal(results.filter((r) => r.status === 201).length, 1, JSON.stringify(results.map((r) => r.status)));
  assert.equal((await f.m.Coupon.findById(f.coupon._id).lean()).used, 1);
});

test("delivery rules: pincode, free-delivery threshold, COD limit", async () => {
  const riya = await loginCustomer("9876543210");
  const addressId = String((await f.m.User.findById(f.riya._id).lean()).addresses[0]._id);
  const item = (qty) => [{ productId: String(f.food._id), variantId: "1kg", qty }];
  const one = await riya.post("/me/orders", { items: item(1), fulfilment: "delivery", payment: "COD", addressId });
  assert.equal(one.body.order.deliveryCharge, 50);
  await f.m.Product.updateOne({ _id: f.food._id }, { $set: { stock: 50 } });
  const two = await riya.post("/me/orders", { items: item(2), fulfilment: "delivery", payment: "COD", addressId });
  assert.equal(two.body.order.deliveryCharge, 0);
  await f.m.Settings.updateOne({ _id: "store" }, { $set: { "data.codLimit": 100 } });
  assert.equal((await riya.post("/me/orders", { items: item(1), fulfilment: "delivery", payment: "COD", addressId })).status, 400);
  await f.m.Settings.updateOne({ _id: "store" }, { $set: { "data.deliveryPincodes": ["111111"] } });
  assert.equal((await riya.post("/me/orders", { items: item(1), fulfilment: "delivery", payment: "PAY_AT_STORE", addressId })).status, 400);
});

test("order cancellation returns stock; a shipped order cannot be cancelled by the customer", async () => {
  const riya = await loginCustomer("9876543210");
  const admin = await loginPanel("admin@t.in");
  const body = { items: [{ productId: String(f.food._id), variantId: "1kg", qty: 2 }], fulfilment: "pickup", payment: "PAY_AT_STORE" };
  const a = await riya.post("/me/orders", body);
  await riya.post(`/me/orders/${a.body.order.id}/cancel`);
  assert.equal((await f.m.Product.findById(f.food._id).lean()).stock, 3);

  const b = await riya.post("/me/orders", body);
  await admin.post(`/panel/orders/${b.body.order.id}/status`, { status: "confirmed" });
  assert.equal((await riya.post(`/me/orders/${b.body.order.id}/cancel`)).status, 409);
  assert.equal((await admin.post(`/panel/orders/${b.body.order.id}/status`, { status: "delivered" })).status, 409);
  assert.equal((await admin.post(`/panel/orders/${b.body.order.id}/status`, { status: "out_for_delivery" })).status, 409);
});

const draft = (extra = {}) => ({
  customerName: "Walk-in",
  customerPhone: "",
  source: { type: "walkin" },
  items: [{ key: "a", kind: "product", refId: String(f.food._id), variantId: "1kg", name: "Dog Food", qty: 1, price: 500, gstRate: 18, code: "HSN 2309" }],
  payments: [],
  ...extra,
});

test("the BRD example bill comes out exactly right", async () => {
  const { billTotals } = await import("../src/lib/money.js");
  const t = billTotals({
    items: [
      { price: 800, qty: 1, gstRate: 18 },
      { price: 350, qty: 1, gstRate: 18 },
    ],
    discountPercent: 10,
    gstEnabled: true,
    payments: [{ amount: 1221 }],
  });
  assert.deepEqual([t.subtotal, t.discount, t.taxable, t.cgst, t.sgst, t.roundOff, t.total, t.due], [1150, 115, 1035, 93.15, 93.15, -0.3, 1221, 0]);
});

test("bill numbers are sequential with no gaps under concurrent billing", async () => {
  await f.m.Product.updateOne({ _id: f.food._id }, { $set: { stock: 100 } });
  const admin = await loginPanel("admin@t.in");
  const out = await Promise.all(Array.from({ length: 8 }, () => admin.post("/panel/invoices", draft())));
  assert.ok(out.every((r) => r.status === 201), JSON.stringify(out.map((r) => r.body)));
  const nums = out.map((r) => Number(r.body.invoice.invoiceNo.replace(/\D/g, ""))).sort((a, b) => a - b);
  assert.equal(new Set(nums).size, 8);
  assert.equal(nums[7] - nums[0], 7);
  assert.equal((await f.m.Product.findById(f.food._id).lean()).stock, 92);
});

test("a failed bill gives its number back and leaves stock alone", async () => {
  const admin = await loginPanel("admin@t.in");
  const good = await admin.post("/panel/invoices", draft());
  const bad = await admin.post("/panel/invoices", draft({ items: [{ ...draft().items[0], qty: 50 }] }));
  assert.equal(bad.status, 409);
  const next = await admin.post("/panel/invoices", draft());
  assert.equal(Number(next.body.invoice.invoiceNo.replace(/\D/g, "")) - Number(good.body.invoice.invoiceNo.replace(/\D/g, "")), 1);
  assert.equal((await f.m.Product.findById(f.food._id).lean()).stock, 1);
});

test("one sale, one bill: a booking can't be billed twice, even in a race", async () => {
  const riya = await loginCustomer("9876543210");
  const { body } = await book(riya, f.riyaPet);
  const admin = await loginPanel("admin@t.in");
  const d = draft({ source: { type: "booking", refId: body.booking.id }, items: [{ key: "s", kind: "service", name: "Bath", qty: 1, price: 600, gstRate: 18, code: "" }] });
  const out = await Promise.all([admin.post("/panel/invoices", d), admin.post("/panel/invoices", d), admin.post("/panel/invoices", d)]);
  assert.equal(out.filter((r) => r.status === 201).length, 1, JSON.stringify(out.map((r) => r.status)));
});

test("an order's items aren't deducted twice when billed, and cancelling the bill keeps them sold", async () => {
  const riya = await loginCustomer("9876543210");
  const admin = await loginPanel("admin@t.in");
  const { body } = await riya.post("/me/orders", { items: [{ productId: String(f.food._id), variantId: "1kg", qty: 1 }], fulfilment: "pickup", payment: "PAY_AT_STORE" });
  assert.equal((await f.m.Product.findById(f.food._id).lean()).stock, 2);
  const inv = await admin.post("/panel/invoices", draft({ source: { type: "order", refId: body.order.id } }));
  assert.equal(inv.status, 201);
  assert.equal((await f.m.Product.findById(f.food._id).lean()).stock, 2);
  await admin.post(`/panel/invoices/${inv.body.invoice.id}/cancel`, { reason: "Wrong amount" });
  assert.equal((await f.m.Product.findById(f.food._id).lean()).stock, 2);
  assert.equal((await f.m.Order.findById(body.order.id).lean()).invoiceId, undefined);
});

test("payments: partial then full, overpayment refused, cancelled bill keeps its record", async () => {
  const admin = await loginPanel("admin@t.in");
  const { body } = await admin.post("/panel/invoices", draft({ payments: [{ mode: "Cash", amount: 100 }] }));
  const id = body.invoice.id;
  assert.equal(body.invoice.status, "partly_paid");
  assert.equal((await admin.post(`/panel/invoices/${id}/payments`, { mode: "UPI", amount: 99999 })).status, 400);
  const paid = await admin.post(`/panel/invoices/${id}/payments`, { mode: "UPI", amount: 490 });
  assert.equal(paid.body.invoice.status, "paid");
  assert.equal((await f.m.Product.findById(f.food._id).lean()).stock, 2);
  await admin.post(`/panel/invoices/${id}/cancel`, { reason: "Billed by mistake" });
  assert.equal((await f.m.Product.findById(f.food._id).lean()).stock, 3);
  assert.equal(await f.m.Invoice.countDocuments({}), 1);
});

test("barcodes: generated codes are unique valid EAN-13, and scanning finds the product", async () => {
  const admin = await loginPanel("admin@t.in");
  const { ean13 } = await import("../src/routes/panelCatalog.js");
  assert.equal(ean13("890100000001").length, 13);
  assert.equal(ean13("400638133393"), "4006381333931");
  const made = await admin.post("/panel/products", { name: "New Toy", category: "toys", petType: "dog", image: "/media/abc", variants: [{ id: "std", label: "Std", price: 100, mrp: 120 }], gstRate: 18, lowStockLevel: 2, active: true, stock: 5 });
  assert.equal(made.status, 201);
  const code = made.body.product.variants[0].barcode;
  assert.match(code, /^890\d{10}$/);
  const scan = await admin.get(`/panel/barcodes/${code}`);
  assert.equal(scan.body.product.name, "New Toy");
  assert.equal(scan.body.variantId, "std");
  assert.equal((await admin.get("/panel/barcodes/0000000000")).status, 404);
  const copy = await admin.post("/panel/products", { name: "Clone", category: "toys", petType: "dog", image: "/media/abc", variants: [{ id: "std", label: "Std", price: 100, mrp: 120, barcode: code }], gstRate: 18, lowStockLevel: 2, active: true });
  assert.equal(copy.status, 409);
});

test("stock adjustments are logged and can't push stock below zero", async () => {
  const admin = await loginPanel("admin@t.in");
  const ok = await admin.post(`/panel/products/${f.food._id}/stock`, { change: 7, reason: "stock_in", note: "Supplier" });
  assert.equal(ok.body.product.stock, 10);
  assert.equal((await admin.post(`/panel/products/${f.food._id}/stock`, { change: -50, reason: "adjustment" })).status, 409);
  assert.equal(await f.m.StockLog.countDocuments({ productId: f.food._id }), 1);
});

test("a blocked customer can't book or order online", async () => {
  await f.m.User.updateOne({ _id: f.riya._id }, { $set: { blocked: true } });
  const riya = await loginCustomer("9876543210");
  assert.equal((await book(riya, f.riyaPet)).status, 403);
});

test("the customer can't cancel inside the cut-off, the store still can", async () => {
  await f.m.Settings.updateOne({ _id: "store" }, { $set: { "data.cancelCutoffHours": 72 } });
  const riya = await loginCustomer("9876543210");
  const { body } = await book(riya, f.riyaPet);
  assert.equal((await riya.post(`/me/bookings/${body.booking.id}/cancel`)).status, 409);
  const admin = await loginPanel("admin@t.in");
  assert.equal((await admin.post(`/panel/bookings/${body.booking.id}/status`, { status: "cancelled", reason: "Called in" })).status, 200);
});

test("no-show counts against the customer", async () => {
  const riya = await loginCustomer("9876543210");
  const { body } = await book(riya, f.riyaPet);
  const admin = await loginPanel("admin@t.in");
  await admin.post(`/panel/bookings/${body.booking.id}/status`, { status: "no_show" });
  assert.equal((await f.m.User.findById(f.riya._id).lean()).noShowCount, 1);
});

test("scheduled jobs cancel stale pending bookings and uncollected orders", async () => {
  const jobs = await import("../src/jobs/index.js");
  const { getSettings } = await import("../src/lib/misc.js");
  await f.m.Settings.updateOne({ _id: "store" }, { $set: { "data.autoConfirm": false } });
  const riya = await loginCustomer("9876543210");
  const { body } = await book(riya, f.riyaPet, { date: tomorrow(1), start: 545 });
  assert.equal(body.booking.status, "pending");
  await jobs.autoCancelUnconfirmed({ ...(await getSettings()), autoCancelHours: 48 });
  assert.equal((await f.m.Booking.findById(body.booking.id).lean()).status, "cancelled");

  const o = await riya.post("/me/orders", { items: [{ productId: String(f.food._id), variantId: "1kg", qty: 1 }], fulfilment: "pickup", payment: "PAY_AT_STORE" });
  await f.m.Order.collection.updateOne({ _id: new f.m.Order.base.Types.ObjectId(o.body.order.id) }, { $set: { status: "ready_for_pickup", updatedAt: new Date(Date.now() - 30 * 86400_000) } });
  await jobs.expireUncollectedOrders(await getSettings());
  assert.equal((await f.m.Order.findById(o.body.order.id).lean()).status, "cancelled");
  assert.equal((await f.m.Product.findById(f.food._id).lean()).stock, 3);
});
