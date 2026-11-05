import pino from "pino";

export const logger = pino({
  level: process.env.NODE_ENV === "test" ? "silent" : process.env.LOG_LEVEL ?? "info",
  redact: {
    paths: ["*.password", "*.otp", "*.phone", "*.email", "*.token", "*.cookie", "*.authorization"],
    censor: "[hidden]",
  },
});
