import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import net from "node:net";
import { test } from "node:test";

const canConnect = (port) =>
  new Promise((resolve) => {
    const s = net.connect(port, "127.0.0.1");
    s.once("connect", () => (s.destroy(), resolve(true)));
    s.once("error", () => resolve(false));
  });

// Hostinger stops an app that hasn't called listen() within 3 seconds, so the port must open before
// Express, Mongoose and the database load. Requests made meanwhile wait for the app.
test("the server opens its port quickly, before the app and the database are ready", async () => {
  const port = 4600 + Math.floor(Math.random() * 300);
  const started = Date.now();
  const child = spawn(process.execPath, ["src/server.js"], {
    env: { ...process.env, NODE_ENV: "test", PORT: String(port), MONGODB_URI: "mongodb://127.0.0.1:1/never", TUNNEL_SECRET: "a".repeat(64), DATA_SECRET: "b".repeat(64), PAWS_NO_AUTOSTART: "" },
    stdio: "ignore",
  });
  try {
    while (!(await canConnect(port)) && Date.now() - started < 10_000) await new Promise((r) => setTimeout(r, 25));
    const took = Date.now() - started;
    assert.ok(took < 1500, `port opened after ${took} ms`);
    // The waiting request is answered by the app, which reports the unreachable database.
    assert.equal((await fetch(`http://127.0.0.1:${port}/healthz`)).status, 503);
  } finally {
    child.kill();
  }
});
