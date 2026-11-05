import http from "node:http";
import { env } from "./config/env.js";
import { logger } from "./lib/logger.js";

/**
 * Starts the API. Hosts such as Hostinger stop an app that hasn't called listen() within 3 seconds,
 * and loading Express, Mongoose and the rest takes about that long on its own. So this file imports
 * only what it needs to listen, opens the port first, and loads the app and the database afterwards.
 * Requests that arrive in the meantime wait and are answered once the app is ready. If the app or the
 * database can't start, the process exits so the host restarts it.
 */
export async function start(port = env.PORT) {
  let handle = null;
  const waiting = [];
  const server = http.createServer((req, res) => (handle ? handle(req, res) : waiting.push([req, res])));
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;
  server.requestTimeout = 60_000;
  server.listen(port, () => logger.info({ port }, "api listening"));

  let jobs;
  let disconnect = async () => {};
  const shutdown = (signal) => {
    logger.info({ signal }, "shutting down");
    clearInterval(jobs);
    server.close(() => disconnect().finally(() => process.exit(0)));
    setTimeout(() => process.exit(1), 15_000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("unhandledRejection", (err) => logger.error({ err }, "unhandled rejection"));

  try {
    const [{ createApp }, db, { startJobs }] = await Promise.all([import("./app.js"), import("./config/db.js"), import("./jobs/index.js")]);
    disconnect = db.disconnectDb;
    // Queries wait for the connection, so the app can take requests while it connects.
    const connected = db.connectDb();
    handle = createApp();
    for (const [req, res] of waiting.splice(0)) handle(req, res);
    await connected;
    jobs = startJobs();
  } catch (err) {
    logger.fatal({ err }, "the API couldn't start");
    for (const [, res] of waiting.splice(0)) {
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { code: "starting", message: "The server is starting. Please try again shortly." } }));
    }
    server.close();
    process.exit(1);
  }
  return server;
}

// This file is the entry point, however the host loads it. Scripts that call start() themselves set PAWS_NO_AUTOSTART.
if (!process.env.PAWS_NO_AUTOSTART) await start();
