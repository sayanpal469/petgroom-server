import fs from "node:fs";
import path from "node:path";
import { MongoMemoryReplSet } from "mongodb-memory-server";

/**
 * Local development without Atlas: a throwaway replica set, seeded with the demo data.
 * Data is lost when this process stops. Login details go to .seed-credentials.txt.
 */
if (process.env.NODE_ENV === "production") throw new Error("dev-memory is for local development only");

const replset = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" } });
process.env.MONGODB_URI = replset.getUri("paws_station");
process.env.TUNNEL_SECRET ??= "c".repeat(64);
process.env.DATA_SECRET ??= "d".repeat(64);

const { start } = await import("../src/server.js");
await start();
const mongoose = (await import("mongoose")).default;
await Promise.all(Object.values(mongoose.models).map((m) => m.init()));
const { runSeed } = await import("./seed-run.js");
const { credentials, stats } = await runSeed({ superPassword: process.env.SEED_SUPER_ADMIN_PASSWORD || "Owner-Local-2026" });
fs.writeFileSync(path.resolve(".seed-credentials.txt"), credentials.map((c) => `${c.role.padEnd(12)} ${c.email.padEnd(28)} ${c.password}`).join("\n") + "\n");
console.log("ready", stats);
