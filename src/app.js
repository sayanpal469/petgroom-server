import compression from "compression";
import cookieParser from "cookie-parser";
import express from "express";
import helmet from "helmet";
import mongoose from "mongoose";
import { env } from "./config/env.js";
import { ApiError, notFound } from "./lib/errors.js";
import { logger } from "./lib/logger.js";
import { streamPublic } from "./lib/media.js";
import { requirePanel } from "./middleware/auth.js";
import { rejectDangerousKeys, sameSiteOnly } from "./middleware/guard.js";
import { generalLimit, handshakeLimit } from "./middleware/rateLimit.js";
import { INNER_PREFIX, handshake, tunnel, tunneledOnly } from "./middleware/tunnel.js";
import { authRouter, meRouter } from "./routes/customer.js";
import panelAdmin from "./routes/panelAdmin.js";
import panelAuth from "./routes/panelAuth.js";
import panelCatalog from "./routes/panelCatalog.js";
import panelOps from "./routes/panelOps.js";
import publicRouter from "./routes/public.js";

export function createApp() {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", env.TRUST_PROXY);
  app.set("query parser", "simple");
  app.set("etag", false);

  app.use(helmet({ crossOriginResourcePolicy: { policy: "same-site" } }));
  app.use(compression({ threshold: 1024 }));

  app.get("/healthz", (_req, res) => {
    const up = mongoose.connection.readyState === 1;
    res.status(up ? 200 : 503).type("text/plain").send(up ? "ok" : "unavailable");
  });

  app.get("/media/:id", (req, res, next) => {
    if (!/^[0-9a-f]{24}$/i.test(req.params.id)) return next(notFound());
    streamPublic(req.params.id, res, next);
  });

  app.use("/api", generalLimit);
  app.post("/api/v1/handshake", handshakeLimit, sameSiteOnly, express.json({ limit: "1kb" }), handshake);
  app.post("/api/v1/t", sameSiteOnly, express.json({ limit: "16mb" }), tunnel);

  const inner = express.Router();
  inner.use(tunneledOnly, cookieParser(), rejectDangerousKeys);
  inner.use("/public", publicRouter);
  inner.use("/auth", authRouter);
  inner.use("/me", meRouter);
  inner.use("/panel/auth", panelAuth);
  inner.use("/panel", requirePanel, panelOps, panelCatalog, panelAdmin);
  app.use(INNER_PREFIX, inner);

  app.use((_req, _res, next) => next(notFound()));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    let status = err.status ?? err.statusCode ?? 500;
    let code = err.code;
    let message = err.message;
    if (err instanceof ApiError) {
      // Written by our own code for the user.
    } else if (status === 413) {
      code = "too_large";
      message = "That is too large to upload.";
    } else if (status >= 400 && status < 500) {
      code = "bad_request";
      message = "Invalid request.";
    } else if (err.name === "CastError" || err.name === "ValidationError") {
      status = 400;
      code = "invalid_input";
      message = "Invalid input.";
    } else if (err.code === 11000) {
      status = 409;
      code = "conflict";
      message = "That already exists.";
    } else {
      status = 500;
      code = "server_error";
      message = "Something went wrong. Please try again.";
      logger.error({ err, path: req.path }, "request failed");
    }
    res.status(status).json({ error: { code, message } });
  });

  return app;
}
