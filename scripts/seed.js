import fs from "node:fs";
import mongoose from "mongoose";
import { connectDb, disconnectDb } from "../src/config/db.js";
import { User } from "../src/models/index.js";
import { CLEAR_BUCKETS, runSeed } from "./seed-run.js";

/**
 * npm run seed            fills an empty database, refuses if it already has accounts
 * npm run seed -- --reset wipes this app's collections first
 */
const reset = process.argv.includes("--reset");
const superPassword = process.env.SEED_SUPER_ADMIN_PASSWORD;
if (!superPassword || superPassword.length < 12) {
  console.error("Set SEED_SUPER_ADMIN_PASSWORD (12+ characters) in .env first.");
  process.exit(1);
}

await connectDb();
await Promise.all(Object.values(mongoose.models).map((m) => m.init()));

if (await User.exists({})) {
  if (!reset) {
    console.error("This database already has data. Nothing was changed. Use `npm run seed -- --reset` to wipe and reseed it.");
    await disconnectDb();
    process.exit(1);
  }
  console.log(`Wiping database "${mongoose.connection.name}"…`);
  await Promise.all(Object.values(mongoose.models).map((m) => m.deleteMany({})));
  await Promise.all(CLEAR_BUCKETS.map((c) => mongoose.connection.db.collection(c).deleteMany({})));
}

const { credentials, stats } = await runSeed({ superEmail: process.env.SEED_SUPER_ADMIN_EMAIL, superPassword });
fs.writeFileSync(".seed-credentials.txt", credentials.map((c) => `${c.role.padEnd(12)} ${c.email.padEnd(28)} ${c.password}`).join("\n") + "\n", { mode: 0o600 });
console.log("Seeded:", stats);
console.log("Login details saved to server/.seed-credentials.txt (not committed to git).");
await disconnectDb();
