import assert from "node:assert/strict";
import crypto from "node:crypto";
import { after, before, beforeEach, test } from "node:test";
import { Client, baseUrl, boot, fixture, loginCustomer, loginPanel, shutdown, tomorrow } from "./helpers.js";

let f;
before(boot);
after(shutdown);
beforeEach(async () => {
  f = await fixture();
});

const SECRET = "test_secret_value_123";
const SHOP = { lat: 22.7246, lng: 88.4808 };
/** A point `m` metres north of the shop. */
const north = (m) => ({ lat: SHOP.lat + m / 111_195, lng: SHOP.lng });

/** A fake Razorpay that remembers orders and payments. */
async function fakeRazorpay() {
  const { setPaymentTransport, savePayConfig } = await import("../src/lib/payments.js");
  await savePayConfig({ enabled: true, keyId: "rzp_test_abcdef123", keySecret: SECRET });
  const rz = { orders: [], payments: new Map(), refunds: [] };
  setPaymentTransport(async (url, init) => {
    const path = new URL(url).pathname.replace("/v1", "");
    const body = init.body ? JSON.parse(init.body) : null;
    if (init.method === "POST" && path === "/orders") {
      const o = { id: `order_T${rz.orders.length + 1}abcdefxyz`, amount: body.amount };
      rz.orders.push(o);
      return { status: 200, body: o };
    }
    let m = path.match(/^\/payments\/([\w]+)$/);
    if (m) return rz.payments.has(m[1]) ? { status: 200, body: rz.payments.get(m[1]) } : { status: 400, body: { error: { description: "no such payment" } } };
    m = path.match(/^\/payments\/([\w]+)\/capture$/);
    if (m) {
      const p = { ...rz.payments.get(m[1]), status: "captured" };
      rz.payments.set(m[1], p);
      return { status: 200, body: p };
    }
    m = path.match(/^\/payments\/([\w]+)\/refund$/);
    if (m) {
      rz.refunds.push({ id: m[1], amount: body.amount });
      return { status: 200, body: { id: `rfnd_${rz.refunds.length}abcdef` } };
    }
    m = path.match(/^\/orders\/([\w]+)\/payments$/);
    if (m) return { status: 200, body: { items: [...rz.payments.values()].filter((p) => p.order_id === m[1]) } };
    return { status: 404, body: { error: { description: `unexpected ${init.method} ${path}` } } };
  });
  rz.pay = (orderId, amount, status = "captured") => {
    const id = `pay_P${rz.payments.size + 1}abcdef`;
    rz.payments.set(id, { id, order_id: orderId, amount, status, method: "upi", created_at: Math.floor(Date.now() / 1000) });
    return { id, signature: crypto.createHmac("sha256", SECRET).update(`${orderId}|${id}`).digest("hex") };
  };
  return rz;
}

const settings = async (patch) => (await import("../src/lib/misc.js")).saveSettings(patch);
const bookBody = (extra = {}) => ({ petId: String(f.riyaPet._id), serviceIds: [String(f.bath._id)], date: tomorrow(2), start: 600, ...extra });

/* ---------- Booking amount ---------- */

test("booking amount: the slot waits for payment, a verified payment confirms it, and the bill counts it", async () => {
  const rz = await fakeRazorpay();
  await settings({ advanceEnabled: true, advanceType: "flat", advanceValue: 200 });
  const riya = await loginCustomer("9876543210");

  const { status, body } = await riya.post("/me/bookings", bookBody());
  assert.equal(status, 201);
  assert.equal(body.booking.status, "pending");
  assert.equal(body.booking.advance.amount, 200);
  assert.equal(body.payment.amount, 20000);
  assert.equal(body.payment.keyId, "rzp_test_abcdef123");
  const id = body.booking.id;

  const forged = await riya.post(`/me/bookings/${id}/pay/verify`, { orderId: body.payment.orderId, paymentId: "pay_Fakeabcdef", signature: "0".repeat(64) });
  assert.equal(forged.status, 400);

  // Paid less than asked: refused even with a good signature.
  const short = rz.pay(body.payment.orderId, 100);
  assert.equal((await riya.post(`/me/bookings/${id}/pay/verify`, { orderId: body.payment.orderId, paymentId: short.id, signature: short.signature })).status, 400);

  const good = rz.pay(body.payment.orderId, 20000, "authorized");
  const paid = await riya.post(`/me/bookings/${id}/pay/verify`, { orderId: body.payment.orderId, paymentId: good.id, signature: good.signature });
  assert.equal(paid.status, 200, JSON.stringify(paid.body));
  assert.equal(paid.body.booking.status, "confirmed");
  assert.equal(paid.body.booking.advance.status, "paid");
  assert.equal(rz.payments.get(good.id).status, "captured");

  // The bill takes the booking amount as an Online payment; the browser can't add one itself.
  const admin = await loginPanel("admin@t.in");
  await f.m.Booking.updateOne({ _id: id }, { $set: { status: "completed" } });
  const item = { key: "b", kind: "service", refId: String(f.bath._id), name: "Bath", qty: 1, price: 600, gstRate: 0, code: "" };
  const fake = await admin.post("/panel/invoices", { customerId: String(f.riya._id), customerName: "Riya", customerPhone: "", source: { type: "booking", refId: id }, items: [item], payments: [{ mode: "Online", amount: 400 }] });
  assert.equal(fake.status, 400);
  const bill = await admin.post("/panel/invoices", { customerId: String(f.riya._id), customerName: "Riya", customerPhone: "", source: { type: "booking", refId: id }, items: [item], payments: [{ mode: "Cash", amount: 100 }] });
  assert.equal(bill.status, 201, JSON.stringify(bill.body));
  assert.deepEqual(
    bill.body.invoice.payments.map((p) => [p.mode, p.amount]),
    [
      ["Online", 200],
      ["Cash", 100],
    ],
  );
  assert.equal(bill.body.invoice.status, "partly_paid");
});

test("booking amount: cancelling refunds it, and an unpaid booking is released when time runs out", async () => {
  const rz = await fakeRazorpay();
  await settings({ advanceEnabled: true, advanceType: "percent", advanceValue: 50 });
  const riya = await loginCustomer("9876543210");

  const a = (await riya.post("/me/bookings", bookBody())).body;
  assert.equal(a.booking.advance.amount, 300);
  const p = rz.pay(a.payment.orderId, 30000);
  // Browser closed before reporting: the check finds the money.
  const checked = await riya.post(`/me/bookings/${a.booking.id}/pay/check`);
  assert.equal(checked.body.booking.advance.status, "paid");
  await riya.post(`/me/bookings/${a.booking.id}/cancel`);
  assert.deepEqual(rz.refunds, [{ id: p.id, amount: 30000 }]);
  assert.equal((await f.m.Booking.findById(a.booking.id).lean()).advance.status, "refunded");

  const b = (await riya.post("/me/bookings", bookBody({ start: 720 }))).body;
  await f.m.Booking.updateOne({ _id: b.booking.id }, { $set: { "advance.dueBy": new Date(Date.now() - 1000) } });
  const { expireUnpaidAdvances } = await import("../src/jobs/index.js");
  await expireUnpaidAdvances();
  const gone = await f.m.Booking.findById(b.booking.id).lean();
  assert.equal(gone.status, "cancelled");
  assert.equal(gone.advance.status, "expired");
  assert.equal(await f.m.SlotHold.countDocuments({ bookingId: gone._id }), 0);
  assert.equal((await riya.post(`/me/bookings/${b.booking.id}/pay`)).status, 409);
});

test("booking amount is off when the gateway isn't set up, and never asked for store bookings", async () => {
  await settings({ advanceEnabled: true, advanceValue: 200 });
  const riya = await loginCustomer("9876543210");
  const r = await riya.post("/me/bookings", bookBody());
  assert.equal(r.body.booking.status, "confirmed");
  assert.equal(r.body.booking.advance, undefined);

  await fakeRazorpay();
  const admin = await loginPanel("admin@t.in");
  const phone = await admin.post("/panel/bookings", { customerId: String(f.riya._id), petId: String(f.riyaPet._id), serviceIds: [String(f.bath._id)], date: tomorrow(2), start: 720, source: "phone" });
  assert.equal(phone.status, 201);
  assert.equal(phone.body.booking.advance, undefined);
});

/* ---------- Pick & drop ---------- */

test("pick & drop: priced from the shop, collected with the customer's code, dropped with the pickup OTP", async () => {
  await settings({ pickDropEnabled: true, shopLat: SHOP.lat, shopLng: SHOP.lng, pickDropBase: 100, pickDropPerKm: 20, pickDropFreeKm: 2, pickDropMaxKm: 10 });
  const driver = await f.m.User.create({ role: "driver", name: "Ravi", email: "ravi@t.in", passwordHash: (await f.m.User.findById(f.admin._id).select("+passwordHash")).passwordHash });
  const otherDriver = await f.m.User.create({ role: "driver", name: "Tapas", email: "tapas@t.in", passwordHash: driver.passwordHash });
  const riya = await loginCustomer("9876543210");

  const far = await riya.post("/me/bookings", bookBody({ pickDrop: { pickup: { ...north(12_000), address: "Far away road 1" } } }));
  assert.equal(far.status, 400);
  assert.equal(far.body.error.code, "pickdrop_far");

  const home = { ...north(4_000), address: "12 Lake Road, Barasat", landmark: "Near the temple" };
  const made = await riya.post("/me/bookings", bookBody({ pickDrop: { pickup: home, drop: home } }));
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const trip = made.body.booking.pickDrop;
  assert.equal(trip.pickup.km, 4);
  assert.equal(trip.pickup.charge, 140);
  assert.equal(trip.charge, 280);
  const id = made.body.booking.id;

  const admin = await loginPanel("admin@t.in");
  assert.equal((await admin.post(`/panel/pickdrop/${id}/assign`, { staffId: String(f.staff._id) })).status, 400);
  const assigned = await admin.post(`/panel/pickdrop/${id}/assign`, { staffId: String(driver._id), window: "9–10 AM" });
  assert.equal(assigned.body.booking.pickDrop.stage, "assigned");

  const code = (await riya.get(`/me/bookings/${id}`)).body.booking.collectOtp;
  assert.match(code, /^\d{6}$/);

  const ravi = await loginPanel("ravi@t.in");
  const tapas = await loginPanel("tapas@t.in");
  assert.equal((await tapas.post(`/panel/pickdrop/${id}/step`, { step: "collected", code })).status, 403);
  assert.equal((await ravi.post(`/panel/pickdrop/${id}/step`, { step: "collected", code: code === "000000" ? "111111" : "000000" })).status, 400);
  assert.equal((await ravi.post(`/panel/pickdrop/${id}/step`, { step: "collected", code })).status, 200);
  const atStore = await ravi.post(`/panel/pickdrop/${id}/step`, { step: "at_store" });
  assert.equal(atStore.body.booking.status, "checked_in");
  assert.equal((await ravi.get("/panel/trips")).body.trips.length, 1);
  assert.equal((await ravi.get("/panel/bookings/x")).status, 404);

  // Not ready yet: can't leave for the drop.
  assert.equal((await ravi.post(`/panel/pickdrop/${id}/step`, { step: "out_for_drop" })).status, 409);
  for (const s of ["grooming_started", "completed", "ready_for_pickup"]) await admin.post(`/panel/bookings/${id}/status`, { status: s });
  assert.equal((await ravi.post(`/panel/pickdrop/${id}/step`, { step: "out_for_drop" })).status, 200);
  const otp = (await riya.get(`/me/bookings/${id}`)).body.booking.pickupOtp;
  const done = await ravi.post(`/panel/pickdrop/${id}/step`, { step: "delivered", code: otp });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal(done.body.booking.status, "picked_up");
  assert.equal(done.body.booking.pickDrop.stage, "delivered");
});

/* ---------- Attendance ---------- */

test("attendance: only inside the shop radius, from one phone, with check-out after check-in", async () => {
  await settings({ shopLat: SHOP.lat, shopLng: SHOP.lng, attendanceRadius: 100 });
  const staff = await loginPanel("staff@t.in");
  const phoneA = "device-aaaaaaaaaaaaaaaa";
  const mark = (kind, p, deviceId = phoneA, accuracy = 20) => staff.post("/panel/attendance/mark", { kind, ...p, accuracy, deviceId });

  const outside = await mark("in", north(300));
  assert.equal(outside.status, 400);
  assert.equal(outside.body.error.code, "outside_shop");
  assert.equal((await mark("in", north(30), phoneA, 900)).body.error.code, "low_accuracy");
  assert.equal((await mark("out", north(30))).status, 409);

  const inside = await mark("in", north(60));
  assert.equal(inside.status, 200, JSON.stringify(inside.body));
  assert.ok(inside.body.today.in.distance >= 55 && inside.body.today.in.distance <= 65);
  assert.equal((await mark("in", north(10))).status, 409);
  // Another phone can't mark for this account.
  assert.equal((await mark("out", north(10), "device-bbbbbbbbbbbbbbbb")).status, 403);
  assert.equal((await mark("out", north(10))).status, 200);

  const admin = await loginPanel("admin@t.in");
  const list = await admin.get(`/panel/attendance?from=${f.today}&to=${tomorrow(1)}`);
  assert.equal(list.body.rows.length, 1);
  assert.ok(list.body.staff.some((s) => s.name === "staff" && s.deviceBound));
  assert.equal((await staff.get(`/panel/attendance?from=${f.today}&to=${f.today}`)).status, 403);
  await admin.post("/panel/attendance/device-reset", { userId: String(f.staff._id) });
  assert.equal((await staff.get("/panel/attendance/me")).body.deviceBound, false);
});

/* ---------- Leads, login SMS, CA, groomer photos ---------- */

test("lead source: from the store's list, on profiles, enquiries and the report", async () => {
  const riya = await loginCustomer("9876543210");
  assert.equal((await riya.patch("/me/profile", { leadSource: "tv_ad" })).status, 400);
  assert.equal((await riya.patch("/me/profile", { leadSource: "reference", leadNote: "Sam" })).status, 200);

  const visitor = await loginCustomer("9876543211");
  await visitor.post("/public/enquiries", { name: "Mita Das", phone: "9123456780", message: "Do you groom cats?", source: "youtube" });
  const admin = await loginPanel("admin@t.in");
  const { enquiries } = (await admin.get("/panel/enquiries")).body;
  assert.equal(enquiries[0].source, "youtube");
  const conv = await admin.post(`/panel/enquiries/${enquiries[0].id}/convert`);
  assert.equal(conv.body.customer.leadSource, "youtube");
  assert.equal(conv.body.enquiry.status, "converted");

  const report = (await admin.get(`/panel/reports/leads?from=${f.today}&to=${f.today}`)).body.rows;
  assert.equal(report.find((r) => r.source === "youtube").converted, 1);
  assert.equal(report.find((r) => r.source === "reference").customers, 1);
});

test("login details by SMS: super admin only, recorded on the customer", async () => {
  const { saveSmsConfig } = await import("../src/lib/sms.js");
  await saveSmsConfig({ siteUrl: "https://paws.example.in" });
  const admin = await loginPanel("admin@t.in");
  assert.equal((await admin.post("/panel/customers/login-sms", { customerIds: [String(f.riya._id)] })).status, 403);
  const owner = await loginPanel("super@t.in");
  const r = await owner.post("/panel/customers/login-sms", { customerIds: [String(f.riya._id), String(f.sam._id)] });
  assert.equal(r.status, 200);
  assert.equal(r.body.sent, 2);
  assert.ok((await f.m.User.findById(f.riya._id).lean()).loginSmsAt);
});

test("CA account: reads bills and GST data, changes nothing", async () => {
  const passwordHash = (await f.m.User.findById(f.admin._id).select("+passwordHash")).passwordHash;
  await f.m.User.create({ role: "accountant", name: "CA Sen", email: "ca@t.in", passwordHash });
  const admin = await loginPanel("admin@t.in");
  const item = { key: "f", kind: "product", refId: String(f.food._id), variantId: "1kg", name: "Dog Food", qty: 1, price: 500, gstRate: 18, code: "HSN 2309" };
  const bill = await admin.post("/panel/invoices", { customerName: "Walk-in", customerPhone: "", source: { type: "walkin" }, items: [item], payments: [{ mode: "Cash", amount: 590 }] });
  assert.equal(bill.status, 201);

  const ca = await loginPanel("ca@t.in");
  const gst = await ca.get(`/panel/gst?from=${f.today}&to=${f.today}`);
  assert.equal(gst.status, 200);
  assert.equal(gst.body.invoices.length, 1);
  assert.equal((await ca.get(`/panel/invoices/${bill.body.invoice.id}/pdf`)).status, 200);
  assert.equal((await ca.post("/panel/invoices", { customerName: "X", customerPhone: "", source: { type: "walkin" }, items: [item], payments: [] })).status, 403);
  assert.equal((await ca.post(`/panel/invoices/${bill.body.invoice.id}/cancel`, { reason: "test" })).status, 403);
  assert.equal((await ca.get("/panel/users")).status, 403);
  const boot = (await ca.get("/panel/bootstrap")).body;
  assert.equal(boot.customers.length, 0);
  assert.equal(boot.invoices.length, 0);
});

test("groomer photo shows on the website", async () => {
  const admin = await loginPanel("admin@t.in");
  const g = f.groomers[0];
  const body = { name: g.name, photo: "/media/0123456789abcdef01234567", color: "#FFD60A", workStart: 540, workEnd: 1200, weeklyOff: [], leaveDays: [], active: true };
  assert.equal((await admin.put(`/panel/groomers/${g._id}`, body)).status, 200);
  const pub = (await admin.get("/public/bootstrap")).body;
  assert.equal(pub.groomers.find((x) => x.id === String(g._id)).photo, "/media/0123456789abcdef01234567");
});

/* ---------- Mobile app clients ---------- */

/** What the app does: no Origin, no cookies, the session token inside the encrypted call. */
class AppClient extends Client {
  headers(extra = {}) {
    const h = { "content-type": "application/json", "x-ps-client": "app", ...extra };
    if (this.origin) h.origin = this.origin;
    return h;
  }
  seal(call) {
    return super.seal(this.token ? { ...call, a: this.token } : call);
  }
}

test("app login: token instead of cookie, works only inside the tunnel, ends on logout", async () => {
  const { OtpChallenge } = f.m;
  const { hmac } = await import("../src/lib/crypto.js");
  await OtpChallenge.updateOne({ phone: "9876543210" }, { $set: { codeHash: hmac("9876543210:123456"), attempts: 0, expiresAt: new Date(Date.now() + 60000) } }, { upsert: true });

  const app = await new AppClient().connect();
  assert.equal((await app.get("/me/bootstrap")).status, 401);
  const login = await app.post("/auth/otp/verify", { phone: "9876543210", code: "123456" });
  assert.equal(login.status, 200);
  assert.match(login.body.token, /^[\w-]{40,}$/);
  assert.equal(app.cookies.size, 0);

  app.token = login.body.token;
  const me = await app.get("/me/bootstrap");
  assert.equal(me.status, 200);
  assert.equal(me.body.user.name, "Riya");

  // A web page can't pretend to be the app: browsers always send Origin.
  const fake = new AppClient();
  fake.origin = "http://evil.test";
  const res = await fetch(`${baseUrl}/api/v1/handshake`, { method: "POST", headers: fake.headers(), body: JSON.stringify({ pub: "x" }) });
  assert.equal(res.status, 403);

  await app.post("/auth/logout");
  assert.equal((await app.get("/me/bootstrap")).status, 401);
});
