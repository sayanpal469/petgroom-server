import { createApp } from "./app.js";
import { connectDb, disconnectDb } from "./config/db.js";
import { env } from "./config/env.js";
import { startJobs } from "./jobs/index.js";
import { logger } from "./lib/logger.js";

export async function start(port = env.PORT) {
  await connectDb();
  const app = createApp();
  const server = app.listen(port, () => logger.info({ port }, "api listening"));
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;
  server.requestTimeout = 60_000;
  const jobs = startJobs();

  const shutdown = (signal) => {
    logger.info({ signal }, "shutting down");
    clearInterval(jobs);
    server.close(() => disconnectDb().finally(() => process.exit(0)));
    setTimeout(() => process.exit(1), 15_000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("unhandledRejection", (err) => logger.error({ err }, "unhandled rejection"));
  return server;
}

if (process.argv[1]?.endsWith("server.js")) await start();
