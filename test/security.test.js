import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { ORIGIN, Client, baseUrl, boot, fixture, loginCustomer, loginPanel, shutdown, tomorrow } from "./helpers.js";

let f;
before(boot);
after(shutdown);
beforeEach(async () => {
  f = await fixture();
});

const bookingFor = (customer, pet, n = 3) => customer.post("/me/bookings", { petId: String(pet._id), serviceIds: [String(f.bath._id)], date: tomorrow(n), start: 600 });

/* ---------- Tunnel ---------- */

test("no inner route answers a plain HTTP request", async () => {
  for (const path of ["/public/bootstrap", "/__inner/public/bootstrap", "/__inner/me/bootstrap", "/__inner/panel/users", "/api/v1/public/bootstrap"]) {
    const res = await fetch(`${baseUrl}${path}`, { headers: { origin: ORIGIN } });
    assert.equal(res.status, 404, path);
  }
});

test("network traffic carries no readable path, field or value", async () => {
  const c = await new Client().connect();
  const r = await c.get("/public/bootstrap");
  assert.equal(r.status, 200);
  assert.equal(r.body.products[0].name, "Dog Food");
  assert.ok(!c.raw.includes("Dog Food"));
  assert.ok(!c.raw.includes("products"));
  assert.deepEqual(Object.keys(JSON.parse(c.raw)).sort(), ["d", "iv"]);
});

test("real status codes stay inside the encrypted reply", async () => {
  const c = await new Client().connect();
  const res = await fetch(`${baseUrl}/api/v1/t`, { method: "POST", headers: c.headers({ "x-ps-kid": c.kid }), body: JSON.stringify(c.seal({ m: "GET", p: "/me/bootstrap", t: Date.now() })) });
  assert.equal(res.status, 200);
  assert.equal(c.open(await res.json()).s, 401);
});

test("a forged key id and a tampered ciphertext are refused", async () => {
  const c = await new Client().connect();
  const bad = await fetch(`${baseUrl}/api/v1/t`, { method: "POST", headers: c.headers({ "x-ps-kid": "AAAA" }), body: JSON.stringify(c.seal({ m: "GET", p: "/public/bootstrap", t: Date.now() })) });
  assert.equal(bad.status, 428);
  const sealed = c.seal({ m: "GET", p: "/public/bootstrap", t: Date.now() });
  const flipped = Buffer.from(sealed.d, "base64");
  flipped[3] ^= 0xff;
  const res = await fetch(`${baseUrl}/api/v1/t`, { method: "POST", headers: c.headers({ "x-ps-kid": c.kid }), body: JSON.stringify({ iv: sealed.iv, d: flipped.toString("base64") }) });
  assert.equal(res.status, 400);
});

test("an old captured request cannot be replayed", async () => {
  const c = await new Client().connect();
  const res = await fetch(`${baseUrl}/api/v1/t`, { method: "POST", headers: c.headers({ "x-ps-kid": c.kid }), body: JSON.stringify(c.seal({ m: "GET", p: "/public/bootstrap", t: Date.now() - 3600_000 })) });
  assert.equal(res.status, 428);
});

test("requests from another site or without the client header are blocked", async () => {
  const c = await new Client().connect();
  const body = JSON.stringify(c.seal({ m: "GET", p: "/public/bootstrap", t: Date.now() }));
  const evil = await fetch(`${baseUrl}/api/v1/t`, { method: "POST", headers: { ...c.headers({ "x-ps-kid": c.kid }), origin: "http://evil.test" }, body });
  assert.equal(evil.status, 403);
  const noHeader = { ...c.headers({ "x-ps-kid": c.kid }) };
  delete noHeader["x-ps-client"];
  assert.equal((await fetch(`${baseUrl}/api/v1/t`, { method: "POST", headers: noHeader, body })).status, 403);
});

test("path traversal inside the tunnel is rejected", async () => {
  const c = await new Client().connect();
  const res = await fetch(`${baseUrl}/api/v1/t`, { method: "POST", headers: c.headers({ "x-ps-kid": c.kid }), body: JSON.stringify(c.seal({ m: "GET", p: "/../healthz", t: Date.now() })) });
  assert.equal(res.status, 400);
});

/* ---------- Access control ---------- */

test("a customer cannot see or change another customer's records", async () => {
  const riya = await loginCustomer("9876543210");
  const sam = await loginCustomer("9876543211");
  const { body } = await bookingFor(riya, f.riyaPet);
  const id = body.booking.id;
  assert.equal((await sam.get(`/me/bookings/${id}`)).status, 404);
  assert.equal((await sam.get(`/me/bookings/${id}/slip`)).status, 404);
  assert.equal((await sam.post(`/me/bookings/${id}/cancel`)).status, 404);
  assert.equal((await sam.put(`/me/pets/${f.riyaPet._id}`, { name: "Hacked", type: "dog", size: "small" })).status, 404);
  assert.equal((await sam.del(`/me/pets/${f.riyaPet._id}`)).status, 404);
  assert.equal((await sam.post("/me/bookings", { petId: String(f.riyaPet._id), serviceIds: [String(f.bath._id)], date: tomorrow(4), start: 600 })).status, 404);
});

test("a customer session is worthless on the panel, and logged-out calls fail", async () => {
  const riya = await loginCustomer("9876543210");
  assert.equal((await riya.get("/panel/bootstrap")).status, 401);
  assert.equal((await riya.get("/panel/users")).status, 401);
  assert.equal((await new Client().get("/me/bootstrap")).status, 401);
  assert.equal((await new Client().get("/panel/bootstrap")).status, 401);
});

test("each role is limited to its own modules", async () => {
  const staff = await loginPanel("staff@t.in");
  const clinic = await loginPanel("clinic@t.in");
  const admin = await loginPanel("admin@t.in");
  const blocked = [
    [staff, "/panel/users"],
    [staff, "/panel/audit"],
    [staff, "/panel/reports/raw?from=2026-01-01&to=2026-01-02"],
    [staff, "/panel/clinic/pets?q=bruno"],
    [clinic, "/panel/users"],
    [clinic, "/panel/work"],
    [clinic, "/panel/reports/raw?from=2026-01-01&to=2026-01-02"],
    [admin, "/panel/users"],
    [admin, "/panel/audit"],
  ];
  for (const [c, path] of blocked) assert.equal((await c.get(path)).status, 403, path);

  const s = await staff.get("/panel/bootstrap");
  assert.equal(s.status, 200);
  assert.deepEqual([s.body.customers.length, s.body.invoices.length, s.body.products.length], [0, 0, 0]);
  const c = await clinic.get("/panel/bootstrap");
  assert.equal(c.body.customers.length, 0);
  assert.equal(c.body.settings, null);
  assert.equal((await staff.post("/panel/invoices", {})).status, 403);
  assert.equal((await clinic.post(`/panel/bookings/${f.riyaPet._id}/status`, { status: "cancelled" })).status, 403);
});

test("a super admin's grant and revoke change access at once", async () => {
  const sup = await loginPanel("super@t.in");
  const staff = await loginPanel("staff@t.in");
  assert.equal((await staff.get("/panel/reports/raw?from=2026-01-01&to=2026-01-02")).status, 403);
  await sup.patch(`/panel/users/${f.staff._id}`, { grants: ["reports.view"] });
  assert.equal((await staff.get("/panel/reports/raw?from=2026-01-01&to=2026-01-02")).status, 200);
  await sup.patch(`/panel/users/${f.staff._id}`, { grants: [], revokes: ["work.own"] });
  assert.equal((await staff.get("/panel/work")).status, 403);
});

test("disabling an account ends its session immediately", async () => {
  const sup = await loginPanel("super@t.in");
  const admin = await loginPanel("admin@t.in");
  assert.equal((await admin.get("/panel/auth/me")).status, 200);
  await sup.patch(`/panel/users/${f.admin._id}`, { status: "disabled" });
  assert.equal((await admin.get("/panel/auth/me")).status, 401);
  const again = await new Client().post("/panel/auth/login", { email: "admin@t.in", password: "Passw0rd!long" });
  assert.equal(again.status, 401);
});

test("the last super admin cannot be removed, and nobody disables themselves", async () => {
  const sup = await loginPanel("super@t.in");
  assert.equal((await sup.patch(`/panel/users/${f.superAdmin._id}`, { status: "disabled" })).status, 400);
  assert.equal((await sup.patch(`/panel/users/${f.superAdmin._id}`, { role: "admin" })).status, 400);
});

test("a staff member works only on their own appointments", async () => {
  const riya = await loginCustomer("9876543210");
  const { body } = await riya.post("/me/bookings", { petId: String(f.riyaPet._id), serviceIds: [String(f.bath._id)], date: tomorrow(3), start: 600, groomerId: String(f.groomers[0]._id) });
  const id = body.booking.id;
  const other = await loginPanel("staff2@t.in");
  assert.equal((await other.post(`/panel/work/${id}/ack`)).status, 404);
  assert.equal((await other.post(`/panel/work/${id}/status`, { status: "checked_in" })).status, 404);
  assert.equal((await other.get("/panel/work")).body.appointments.length, 0);
  const mine = await loginPanel("staff@t.in");
  const work = await mine.get("/panel/work");
  assert.equal(work.body.appointments.length, 1);
  assert.equal(work.body.customers[0].name, "Riya");
  assert.equal((await mine.post(`/panel/work/${id}/ack`)).body.booking.status, "scheduled");
});

/* ---------- Input ---------- */

test("mass assignment: unknown fields are refused, not ignored", async () => {
  const riya = await loginCustomer("9876543210");
  assert.equal((await riya.patch("/me/profile", { name: "Riya", role: "super_admin" })).status, 400);
  assert.equal((await riya.patch("/me/profile", { noShowCount: 0 })).status, 400);
  const sup = await loginPanel("super@t.in");
  assert.equal((await sup.patch(`/panel/users/${f.staff._id}`, { passwordHash: "x" })).status, 400);
  assert.equal((await sup.patch(`/panel/users/${f.staff._id}`, { grants: ["fly.to.moon"] })).status, 400);
});

test("NoSQL operator injection is blocked at every depth", async () => {
  const c = await new Client().connect();
  assert.equal((await c.post("/panel/auth/login", { email: { $gt: "" }, password: { $gt: "" } })).status, 403);
  assert.equal((await c.post("/auth/otp/verify", { phone: { $ne: null }, code: "123456" })).status, 403);
  assert.equal((await c.post("/public/coupons/check", { code: "x", subtotal: 1, extra: [{ deep: { $where: "1" } }] })).status, 403);
  assert.equal((await c.post("/public/enquiries", { constructor: { prototype: {} } })).status, 403);
});

test("search text is escaped, so a crafted pattern cannot match everything or hang the server", async () => {
  const clinic = await loginPanel("clinic@t.in");
  const r = await clinic.get(`/panel/clinic/pets?q=${encodeURIComponent(".*")}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.pets.length, 0);
  const slow = await clinic.get(`/panel/clinic/pets?q=${encodeURIComponent("(a+)+$")}`);
  assert.equal(slow.status, 200);
});

test("the server never trusts a price from the browser", async () => {
  const riya = await loginCustomer("9876543210");
  const r = await riya.post("/me/orders", { items: [{ productId: String(f.food._id), variantId: "1kg", qty: 1, price: 1 }], fulfilment: "pickup", payment: "PAY_AT_STORE" });
  assert.equal(r.status, 400);
  const ok = await riya.post("/me/orders", { items: [{ productId: String(f.food._id), variantId: "1kg", qty: 1 }], fulfilment: "pickup", payment: "PAY_AT_STORE" });
  assert.equal(ok.body.order.items[0].price, 500);
});

/* ---------- Data exposure ---------- */

test("responses never contain secrets", async () => {
  const sup = await loginPanel("super@t.in");
  const r = await sup.get("/panel/users");
  const text = JSON.stringify(r.body);
  for (const word of ["passwordHash", "s1$", "failedLogins", "lockedUntil", "tokenHash"]) assert.ok(!text.includes(word), word);
});

test("the storefront does not reveal exact stock or internal fields", async () => {
  await f.m.Product.updateOne({ _id: f.food._id }, { $set: { stock: 900 } });
  const { body } = await new Client().get("/public/bootstrap");
  const p = body.products[0];
  assert.equal(p.stock, 25);
  for (const k of ["hsn", "gstRate", "lowStockLevel", "active"]) assert.ok(!(k in p), k);
  assert.ok(!("barcode" in p.variants[0]));
  for (const k of ["templates", "invoicePrefix", "noShowFlagAt"]) assert.ok(!(k in body.store), k);
  for (const g of body.groomers) assert.ok(!("phone" in g));
});

test("the pickup OTP is visible only to the booking's owner, never to staff or admin APIs", async () => {
  const riya = await loginCustomer("9876543210");
  const { body } = await bookingFor(riya, f.riyaPet);
  const id = body.booking.id;
  const admin = await loginPanel("admin@t.in");
  for (const s of ["checked_in", "grooming_started", "in_progress", "completed", "ready_for_pickup"]) assert.equal((await admin.post(`/panel/bookings/${id}/status`, { status: s })).status, 200, s);
  const own = await riya.get(`/me/bookings/${id}`);
  assert.match(own.body.booking.pickupOtp, /^\d{6}$/);
  const panel = await admin.get("/panel/bootstrap");
  const text = JSON.stringify(panel.body);
  assert.ok(!text.includes(own.body.booking.pickupOtp));
  assert.ok(!text.includes("otpSealed"));
});

/* ---------- Login ---------- */

test("wrong email and wrong password give the same answer", async () => {
  const a = await new Client().post("/panel/auth/login", { email: "nobody@t.in", password: "whatever-123" });
  const b = await new Client().post("/panel/auth/login", { email: "admin@t.in", password: "whatever-123" });
  assert.equal(a.status, 401);
  assert.deepEqual(a.body, b.body);
});

test("an account locks after repeated wrong passwords, even with the right one", async () => {
  const c = new Client();
  for (let i = 0; i < 20; i++) await c.post("/panel/auth/login", { email: "admin@t.in", password: "wrong-pass-1" });
  assert.equal((await new Client().post("/panel/auth/login", { email: "admin@t.in", password: "Passw0rd!long" })).status, 401);
});

test("OTPs are stored hashed, single-use, and die after five wrong tries", async () => {
  const c = await new Client().connect();
  assert.equal((await c.post("/auth/otp/request", { phone: "9000000001" })).status, 200);
  const stored = await f.m.OtpChallenge.findOne({ phone: "9000000001" }).lean();
  assert.match(stored.codeHash, /^[0-9a-f]{64}$/);

  const { hmac } = await import("../src/lib/crypto.js");
  await f.m.OtpChallenge.updateOne({ phone: "9000000001" }, { $set: { codeHash: hmac("9000000001:111111") } });
  for (let i = 0; i < 5; i++) assert.equal((await c.post("/auth/otp/verify", { phone: "9000000001", code: "000000" })).status, 400);
  assert.equal((await c.post("/auth/otp/verify", { phone: "9000000001", code: "111111" })).status, 400);

  await f.m.OtpChallenge.updateOne({ phone: "9000000001" }, { $set: { attempts: 0 } });
  assert.equal((await c.post("/auth/otp/verify", { phone: "9000000001", code: "111111" })).status, 200);
  assert.equal((await new Client().post("/auth/otp/verify", { phone: "9000000001", code: "111111" })).status, 400);
});

test("a panel account cannot be entered through customer OTP login", async () => {
  await f.m.User.updateOne({ _id: f.admin._id }, { $set: { phone: "9000000002" } });
  const { hmac } = await import("../src/lib/crypto.js");
  await f.m.OtpChallenge.create({ phone: "9000000002", codeHash: hmac("9000000002:222222"), expiresAt: new Date(Date.now() + 60000) });
  assert.equal((await new Client().post("/auth/otp/verify", { phone: "9000000002", code: "222222" })).status, 400);
});

test("session cookie is httpOnly and the panel and shop use separate cookies", async () => {
  const c = await new Client().connect();
  const res = await fetch(`${baseUrl}/api/v1/t`, { method: "POST", headers: c.headers({ "x-ps-kid": c.kid }), body: JSON.stringify(c.seal({ m: "POST", p: "/panel/auth/login", b: { email: "admin@t.in", password: "Passw0rd!long" }, t: Date.now() })) });
  const cookie = res.headers.getSetCookie()[0];
  assert.match(cookie, /^ps_p=/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
});

test("logout really ends the session on the server", async () => {
  const admin = await loginPanel("admin@t.in");
  const stolen = new Map(admin.cookies);
  await admin.post("/panel/auth/logout");
  const thief = await new Client().connect();
  thief.cookies = stolen;
  assert.equal((await thief.get("/panel/auth/me")).status, 401);
});

test("weak panel passwords are refused", async () => {
  const sup = await loginPanel("super@t.in");
  assert.equal((await sup.post("/panel/users", { name: "New", email: "n@t.in", role: "admin", password: "short1" })).status, 400);
  assert.equal((await sup.post("/panel/users", { name: "New", email: "n@t.in", role: "admin", password: "onlyletterslong" })).status, 400);
});

/* ---------- OTP provider ---------- */

const demo = async () => {
  const { saveSmsConfig } = await import("../src/lib/sms.js");
  await saveSmsConfig({ enabled: false, customerId: "", passwordSealed: "", demoEnabled: true, demoPhone: "1234567890", demoCode: "1234" });
};

test("the demo number logs in with its fixed code, and only with that code", async () => {
  await demo();
  await f.m.User.create({ role: "customer", name: "Demo", phone: "1234567890" });
  const c = await new Client().connect();
  assert.equal((await c.post("/auth/otp/request", { phone: "1234567890" })).status, 200);
  assert.equal((await c.post("/auth/otp/verify", { phone: "1234567890", code: "9999" })).status, 400);
  assert.equal((await c.post("/auth/otp/verify", { phone: "1234567890", code: "1234" })).status, 200);
  assert.equal((await c.get("/auth/me")).body.user.name, "Demo");
});

test("the demo code works on no other number, and stops when demo login is off", async () => {
  await demo();
  assert.equal((await new Client().post("/auth/otp/verify", { phone: "9876543210", code: "1234" })).status, 400);
  const { saveSmsConfig } = await import("../src/lib/sms.js");
  await saveSmsConfig({ demoEnabled: false });
  assert.equal((await new Client().post("/auth/otp/verify", { phone: "1234567890", code: "1234" })).status, 400);
  assert.equal((await new Client().post("/auth/otp/request", { phone: "1234567890" })).status, 400);
});

test("the Message Central password never comes back, and non-settings roles can't touch it", async () => {
  const admin = await loginPanel("admin@t.in");
  const saved = await admin.put("/panel/sms", { enabled: true, customerId: "C-1", password: "s3cret-value", demoEnabled: false, demoPhone: "", demoCode: "" });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.sms.hasPassword, true);
  const stored = await f.m.Settings.findById("sms").lean();
  assert.ok(!JSON.stringify(stored).includes("s3cret-value"));
  for (const r of [saved.body, (await admin.get("/panel/sms")).body, (await admin.get("/panel/bootstrap")).body]) {
    assert.ok(!JSON.stringify(r).includes("s3cret-value"));
    assert.ok(!JSON.stringify(r).includes("passwordSealed"));
  }
  const staff = await loginPanel("staff@t.in");
  assert.equal((await staff.get("/panel/sms")).status, 403);
  assert.equal((await staff.put("/panel/sms", {})).status, 403);
  const { saveSmsConfig } = await import("../src/lib/sms.js");
  await saveSmsConfig({ enabled: false, customerId: "", passwordSealed: "" });
});

test("OTP login goes through Message Central with the documented calls", async () => {
  const admin = await loginPanel("admin@t.in");
  await admin.put("/panel/sms", { enabled: true, customerId: "C-1", password: "pw", demoEnabled: false, demoPhone: "", demoCode: "" });
  const real = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    if (!String(url).startsWith("https://cpaas.messagecentral.com")) return real(url, init);
    const u = new URL(url);
    calls.push({ path: u.pathname, method: init?.method ?? "GET", q: Object.fromEntries(u.searchParams), auth: init?.headers?.authToken });
    if (u.pathname.endsWith("/token")) return Response.json({ status: 200, token: "tok" });
    if (u.pathname.endsWith("/send")) return Response.json({ responseCode: 200, data: { verificationId: 777 } });
    return Response.json({ responseCode: 200, data: { verificationStatus: u.searchParams.get("code") === "4321" ? "VERIFICATION_COMPLETED" : "FAILED" } });
  };
  try {
    const c = await new Client().connect();
    assert.equal((await c.post("/auth/otp/request", { phone: "9876543210" })).status, 200);
    assert.equal((await c.post("/auth/otp/verify", { phone: "9876543210", code: "1111" })).status, 400);
    assert.equal((await c.post("/auth/otp/verify", { phone: "9876543210", code: "4321" })).status, 200);
  } finally {
    globalThis.fetch = real;
    const { saveSmsConfig } = await import("../src/lib/sms.js");
    await saveSmsConfig({ enabled: false, customerId: "", passwordSealed: "" });
  }
  const send = calls.find((x) => x.path.endsWith("/send"));
  assert.equal(calls[0].q.key, Buffer.from("pw").toString("base64"));
  assert.deepEqual([send.method, send.auth, send.q.mobileNumber, send.q.countryCode, send.q.flowType, send.q.otpLength], ["POST", "tok", "9876543210", "91", "SMS", "4"]);
  assert.equal(calls.find((x) => x.path.endsWith("/validateOtp")).q.verificationId, "777");
});

test("a saved Message Central auth token is used as it is and never comes back", async () => {
  const jwt = "eyJhbGciOiJIUzUxMiJ9.eyJzdWIiOiJDLTEifQ.c2lnbmF0dXJl";
  const admin = await loginPanel("admin@t.in");
  assert.equal((await admin.put("/panel/sms", { enabled: true, customerId: "C-1", authToken: "not a token", demoEnabled: false, demoPhone: "", demoCode: "" })).status, 400);
  const saved = await admin.put("/panel/sms", { enabled: true, customerId: "C-1", authToken: jwt, demoEnabled: false, demoPhone: "", demoCode: "" });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.sms.hasToken, true);
  assert.ok(!JSON.stringify(await f.m.Settings.findById("sms").lean()).includes(jwt));
  for (const r of [saved.body, (await admin.get("/panel/sms")).body, (await admin.get("/panel/bootstrap")).body]) {
    assert.ok(!JSON.stringify(r).includes(jwt));
    assert.ok(!JSON.stringify(r).includes("tokenSealed"));
  }

  const real = globalThis.fetch;
  const calls = [];
  let tokenWorks = true;
  globalThis.fetch = async (url, init) => {
    if (!String(url).startsWith("https://cpaas.messagecentral.com")) return real(url, init);
    const u = new URL(url);
    calls.push({ path: u.pathname, auth: init?.headers?.authToken });
    if (!tokenWorks) return new Response(null, { status: 401 });
    if (u.pathname.endsWith("/send")) return Response.json({ responseCode: 200, data: { verificationId: 888 } });
    if (u.searchParams.get("verificationId") === "0") return Response.json({ responseCode: 505, data: null }, { status: 400 });
    return Response.json({ responseCode: 200, data: { verificationStatus: u.searchParams.get("code") === "5678" ? "VERIFICATION_COMPLETED" : "FAILED" } });
  };
  try {
    assert.equal((await admin.post("/panel/sms/test")).status, 200);
    const c = await new Client().connect();
    assert.equal((await c.post("/auth/otp/request", { phone: "9876543211" })).status, 200);
    assert.equal((await c.post("/auth/otp/verify", { phone: "9876543211", code: "5678" })).status, 200);
    tokenWorks = false;
    assert.equal((await admin.post("/panel/sms/test")).status, 400);
  } finally {
    globalThis.fetch = real;
    const { saveSmsConfig } = await import("../src/lib/sms.js");
    await saveSmsConfig({ enabled: false, customerId: "", passwordSealed: "", tokenSealed: "" });
  }
  assert.ok(!calls.some((x) => x.path.endsWith("/token")), "a saved token needs no token request");
  assert.ok(calls.every((x) => x.auth === jwt));
});

/* ---------- Clinic ---------- */

const jpeg = async () => (await (await import("sharp")).default({ create: { width: 40, height: 40, channels: 3, background: "#fff" } }).jpeg().toBuffer()).toString("base64");

test("clinic accepts JPEG only and rejects PDF, PNG and disguised files", async () => {
  const clinic = await loginPanel("clinic@t.in");
  const url = `/panel/clinic/pets/${f.riyaPet._id}/prescriptions`;
  const sharp = (await import("sharp")).default;
  const png = (await sharp({ create: { width: 40, height: 40, channels: 3, background: "#fff" } }).png().toBuffer()).toString("base64");
  assert.equal((await clinic.post(url, { image: png })).status, 400);
  assert.equal((await clinic.post(url, { image: Buffer.from("%PDF-1.7 fake").toString("base64") })).status, 400);
  assert.equal((await clinic.post(url, { image: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]).toString("base64") })).status, 400);
  assert.equal((await clinic.post(url, { image: await jpeg() })).status, 201);
});

test("prescription images stay out of public media and away from unauthorised roles", async () => {
  const clinic = await loginPanel("clinic@t.in");
  const { body } = await clinic.post(`/panel/clinic/pets/${f.riyaPet._id}/prescriptions`, { image: await jpeg(), note: "ear drops" });
  const row = await f.m.Prescription.findById(body.prescription.id).lean();
  assert.equal((await fetch(`${baseUrl}/media/${row.fileId}`)).status, 404);
  const staff = await loginPanel("staff@t.in");
  assert.equal((await staff.get(`/panel/clinic/prescriptions/${row._id}/image`)).status, 403);
  const riya = await loginCustomer("9876543210");
  assert.equal((await riya.get(`/panel/clinic/prescriptions/${row._id}/image`)).status, 401);
  const view = await clinic.get(`/panel/clinic/prescriptions/${row._id}/image`);
  assert.equal(view.status, 200);
  assert.equal(Buffer.from(view.body.base64, "base64")[0], 0xff);
  const pet = await clinic.get(`/panel/clinic/pets/${f.riyaPet._id}`);
  assert.equal(pet.body.prescriptions.length, 1);
  assert.match(pet.body.pet.ownerPhone, /•/);
});

test("the clinic search shows a masked phone and no customer details", async () => {
  const clinic = await loginPanel("clinic@t.in");
  const { body } = await clinic.get("/panel/clinic/pets?q=bruno");
  assert.equal(body.pets.length, 1);
  assert.ok(!JSON.stringify(body).includes("9876543210"));
  assert.ok(!("address" in body.pets[0]));
});

test("uploads have EXIF data removed", async () => {
  const sharp = (await import("sharp")).default;
  const withExif = await sharp({ create: { width: 40, height: 40, channels: 3, background: "#fff" } }).withExif({ IFD0: { Copyright: "SECRET-GPS" } }).jpeg().toBuffer();
  assert.ok(withExif.includes("SECRET-GPS"));
  const clinic = await loginPanel("clinic@t.in");
  const { body } = await clinic.post(`/panel/clinic/pets/${f.riyaPet._id}/prescriptions`, { image: withExif.toString("base64") });
  const view = await clinic.get(`/panel/clinic/prescriptions/${body.prescription.id}/image`);
  assert.ok(!Buffer.from(view.body.base64, "base64").includes("SECRET-GPS"));
});

/* ---------- Audit ---------- */

test("sensitive actions are recorded in the activity log", async () => {
  const sup = await loginPanel("super@t.in");
  await sup.patch(`/panel/users/${f.staff._id}`, { name: "Renamed" });
  await new Promise((r) => setTimeout(r, 100));
  const { body } = await sup.get("/panel/audit?module=users");
  assert.ok(body.rows.some((r) => r.action === "update"));
});
