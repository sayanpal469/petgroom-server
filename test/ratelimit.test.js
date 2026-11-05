import assert from "node:assert/strict";
import { after, before, test } from "node:test";

process.env.TEST_RATE_LIMITS = "1";

const helpers = await import("./helpers.js");
const { Client, boot, fixture, shutdown } = helpers;

let f;
before(async () => {
  await boot();
  f = await fixture();
});
after(shutdown);

test("OTP requests are limited per phone number, whatever the IP", async () => {
  const statuses = [];
  for (let i = 0; i < 6; i++) statuses.push((await new Client({ ip: `10.0.0.${i}` }).post("/auth/otp/request", { phone: "9000000050" })).status);
  assert.deepEqual(statuses, [200, 200, 200, 200, 429, 429]);
});

test("login attempts are limited per IP and email, and the limit is shared in the database", async () => {
  const c = new Client({ ip: "10.0.1.1" });
  const statuses = [];
  for (let i = 0; i < 10; i++) statuses.push((await c.post("/panel/auth/login", { email: "clinic@t.in", password: "wrong-pass-1" })).status);
  assert.equal(statuses.filter((s) => s === 429).length, 2, statuses.join());
  assert.ok(await f.m.RateCounter.exists({ _id: /^login:/ }));
});

test("the limiter sees the real client IP from the proxy, one abuser does not lock out others", async () => {
  const other = await new Client({ ip: "10.0.1.2" }).post("/panel/auth/login", { email: "clinic@t.in", password: "Passw0rd!long" });
  assert.equal(other.status, 200);
});

test("a flood of plain requests is cut off", async () => {
  const headers = { "x-forwarded-for": "10.9.9.9", origin: "http://site.test", "x-ps-client": "web", "content-type": "application/json" };
  const hits = [];
  for (let i = 0; i < 14; i++) {
    hits.push(...(await Promise.all(Array.from({ length: 50 }, () => fetch(`${helpers.baseUrl}/api/v1/handshake`, { method: "POST", headers, body: "{}" }).then((r) => r.status)))));
  }
  assert.ok(hits.includes(429));
});
