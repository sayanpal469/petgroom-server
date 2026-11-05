import crypto from "node:crypto";
import { MongoMemoryReplSet } from "mongodb-memory-server";

process.env.NODE_ENV = "test";
process.env.TUNNEL_SECRET = "a".repeat(64);
process.env.DATA_SECRET = "b".repeat(64);
process.env.MONGODB_URI = "mongodb://unused";
process.env.ALLOWED_ORIGINS = "http://site.test,http://panel.test";
process.env.TRUST_PROXY = "1";

export const ORIGIN = "http://site.test";

let replset;
let server;
export let baseUrl;

export async function boot() {
  replset = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" } });
  const { connectDb } = await import("../src/config/db.js");
  await connectDb(replset.getUri("paws_test"));
  const { createApp } = await import("../src/app.js");
  const mongoose = (await import("mongoose")).default;
  await Promise.all(Object.values(mongoose.models).map((m) => m.init()));
  server = await new Promise((resolve) => {
    const s = createApp().listen(0, "127.0.0.1", () => resolve(s));
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
}

export async function shutdown() {
  const { disconnectDb } = await import("../src/config/db.js");
  await new Promise((r) => server.close(r));
  await disconnectDb();
  await replset.stop();
}

/** What the browser does: ECDH handshake, then every call inside AES-GCM, with a cookie jar. */
export class Client {
  constructor({ ip } = {}) {
    this.cookies = new Map();
    this.ip = ip;
  }
  headers(extra = {}) {
    const h = { "content-type": "application/json", origin: ORIGIN, "x-ps-client": "web", ...extra };
    if (this.ip) h["x-forwarded-for"] = this.ip;
    if (this.cookies.size) h.cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
    return h;
  }
  async connect() {
    const ecdh = crypto.createECDH("prime256v1");
    ecdh.generateKeys();
    const res = await fetch(`${baseUrl}/api/v1/handshake`, { method: "POST", headers: this.headers(), body: JSON.stringify({ pub: ecdh.getPublicKey("base64") }) });
    const hs = await res.json();
    const secret = ecdh.computeSecret(Buffer.from(hs.pub, "base64"));
    this.key = Buffer.from(crypto.hkdfSync("sha256", secret, Buffer.from(hs.salt, "base64"), "paws-tunnel-v1", 32));
    this.kid = hs.kid;
    return this;
  }
  seal(call) {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv("aes-256-gcm", this.key, iv);
    c.setAAD(Buffer.from("req"));
    const body = Buffer.concat([c.update(JSON.stringify(call)), c.final(), c.getAuthTag()]);
    return { iv: iv.toString("base64"), d: body.toString("base64") };
  }
  open(env) {
    const raw = Buffer.from(env.d, "base64");
    const d = crypto.createDecipheriv("aes-256-gcm", this.key, Buffer.from(env.iv, "base64"));
    d.setAAD(Buffer.from("res"));
    d.setAuthTag(raw.subarray(raw.length - 16));
    return JSON.parse(Buffer.concat([d.update(raw.subarray(0, raw.length - 16)), d.final()]).toString());
  }
  async call(method, path, body) {
    if (!this.key) await this.connect();
    const res = await fetch(`${baseUrl}/api/v1/t`, { method: "POST", headers: this.headers({ "x-ps-kid": this.kid }), body: JSON.stringify(this.seal({ m: method, p: path, b: body, t: Date.now() })) });
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(";");
      const i = pair.indexOf("=");
      const name = pair.slice(0, i);
      const value = pair.slice(i + 1);
      if (value) this.cookies.set(name, value);
      else this.cookies.delete(name);
    }
    this.raw = await res.clone().text();
    const env = await res.json();
    if (env.error) return { status: res.status, body: env };
    const inner = this.open(env);
    return { status: inner.s, body: inner.b };
  }
  get = (p) => this.call("GET", p);
  post = (p, b = {}) => this.call("POST", p, b);
  put = (p, b = {}) => this.call("PUT", p, b);
  patch = (p, b = {}) => this.call("PATCH", p, b);
  del = (p) => this.call("DELETE", p);
}

export const tomorrow = (n = 1) => {
  const d = new Date(Date.now() + 5.5 * 3600_000 + n * 86400_000);
  return d.toISOString().slice(0, 10);
};

/** Small store: three groomers, two services, two products, a coupon, one account per role. */
export async function fixture() {
  const m = await import("../src/models/index.js");
  const { hashPassword } = await import("../src/lib/crypto.js");
  const { saveSettings } = await import("../src/lib/misc.js");
  const mongoose = (await import("mongoose")).default;
  await Promise.all(Object.values(mongoose.models).map((x) => x.deleteMany({})));

  await saveSettings({ slotCapacity: 3, slotMinutes: 30, openTime: 540, closeTime: 1200, autoConfirm: true, holidays: [], closedDays: [], cancelCutoffHours: 3 });
  const mkG = (name) => m.Groomer.create({ name, role: "Groomer", color: "#FFD60A", workStart: 540, workEnd: 1200, weeklyOff: [], leaveDays: [], active: true });
  const groomers = [await mkG("Asha"), await mkG("Bikram"), await mkG("Chitra")];
  const sized = (n) => ({ small: n, medium: n, large: n });
  const bath = await m.Service.create({ slug: "bath", name: "Bath", category: "bath", prices: sized(600), durations: sized(30), active: true });
  const cut = await m.Service.create({ slug: "cut", name: "Haircut", category: "styling", prices: sized(800), durations: sized(60), active: true });
  const food = await m.Product.create({ slug: "food", name: "Dog Food", category: "food", petType: "dog", image: "/x.jpg", variants: [{ id: "1kg", label: "1 kg", price: 500, mrp: 600, barcode: "8900000000017" }], stock: 3, gstRate: 18, hsn: "2309", active: true });
  const today = new Date().toISOString().slice(0, 10);
  const coupon = await m.Coupon.create({ code: "ONE", type: "percent", value: 10, minAmount: 0, startDate: "2020-01-01", endDate: "2099-01-01", usageLimit: 1, active: true });

  const passwordHash = await hashPassword("Passw0rd!long");
  const panel = async (role, email, extra = {}) => m.User.create({ role, name: role, email, passwordHash, ...extra });
  const superAdmin = await panel("super_admin", "super@t.in");
  const admin = await panel("admin", "admin@t.in");
  const staff = await panel("staff", "staff@t.in", { groomerId: groomers[0]._id });
  const staff2 = await panel("staff", "staff2@t.in", { groomerId: groomers[1]._id });
  const clinic = await panel("clinic", "clinic@t.in");

  const riya = await m.User.create({ role: "customer", name: "Riya", phone: "9876543210", addresses: [{ label: "Home", kind: "home", line1: "1 Park St", city: "Kolkata", pincode: "700124", state: "WB", phone: "9876543210", isDefault: true }] });
  const sam = await m.User.create({ role: "customer", name: "Sam", phone: "9876543211" });
  const riyaPet = await m.Pet.create({ userId: riya._id, name: "Bruno", type: "dog", size: "large" });
  const samPet = await m.Pet.create({ userId: sam._id, name: "Coco", type: "cat", size: "small" });
  return { m, groomers, bath, cut, food, coupon, superAdmin, admin, staff, staff2, clinic, riya, sam, riyaPet, samPet, today };
}

export async function loginCustomer(phone) {
  const { OtpChallenge } = await import("../src/models/index.js");
  const { hmac } = await import("../src/lib/crypto.js");
  const c = await new Client().connect();
  await OtpChallenge.updateOne({ phone }, { $set: { codeHash: hmac(`${phone}:123456`), attempts: 0, expiresAt: new Date(Date.now() + 60000) } }, { upsert: true });
  const r = await c.post("/auth/otp/verify", { phone, code: "123456" });
  if (r.status !== 200) throw new Error(`customer login failed: ${JSON.stringify(r)}`);
  return c;
}

export async function loginPanel(email) {
  const c = await new Client().connect();
  const r = await c.post("/panel/auth/login", { email, password: "Passw0rd!long" });
  if (r.status !== 200) throw new Error(`panel login failed: ${JSON.stringify(r)}`);
  return c;
}
