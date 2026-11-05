import mongoose from "mongoose";
import { env } from "./env.js";
import { logger } from "../lib/logger.js";

mongoose.set("strictQuery", true);

export async function connectDb(uri = env.MONGODB_URI) {
  await mongoose.connect(uri, {
    maxPoolSize: env.DB_POOL_SIZE,
    minPoolSize: 2,
    serverSelectionTimeoutMS: 10_000,
    socketTimeoutMS: 45_000,
  });
  logger.info({ db: mongoose.connection.name }, "mongodb connected");
  return mongoose.connection;
}

export const disconnectDb = () => mongoose.disconnect();

/** Runs fn in a transaction. Mongo retries it on transient write conflicts, so fn must be safe to re-run. */
export async function withTxn(fn) {
  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      result = await fn(session);
    });
    return result;
  } finally {
    await session.endSession();
  }
}
