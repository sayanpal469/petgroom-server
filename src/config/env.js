import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

// Hosts such as Hostinger start the entry file directly, without `--env-file`, so read server/.env here.
// Values already set in the environment (the hosting panel) win over the file. Tests use their own values.
const envFile = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../.env");
if (process.env.NODE_ENV !== "test" && fs.existsSync(envFile)) process.loadEnvFile(envFile);

const hex32 = z.string().regex(/^[0-9a-f]{64}$/i, "must be 32 random bytes as hex");

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  // A number, or a socket path when the host hands one over.
  PORT: z
    .string()
    .trim()
    .min(1)
    .default("4000")
    .transform((v) => (/^\d+$/.test(v) ? Number(v) : v)),
  MONGODB_URI: z.string().min(1),
  TUNNEL_SECRET: hex32,
  DATA_SECRET: hex32,
  ALLOWED_ORIGINS: z.string().default("http://localhost:3000,http://localhost:3001"),
  TRUST_PROXY: z.coerce.number().int().min(0).default(1),
  DB_POOL_SIZE: z.coerce.number().int().positive().default(50),
  WEB_CONCURRENCY: z.coerce.number().int().min(0).optional().catch(undefined),
  LOG_LEVEL: z.string().default("info"),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  const lines = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`);
  throw new Error(`Invalid server environment:\n${lines.join("\n")}\nSee .env.example`);
}

export const env = {
  ...parsed.data,
  isProd: parsed.data.NODE_ENV === "production",
  isTest: parsed.data.NODE_ENV === "test",
  origins: parsed.data.ALLOWED_ORIGINS.split(",").map((s) => s.trim().replace(/\/$/, "")).filter(Boolean),
  tunnelKey: Buffer.from(parsed.data.TUNNEL_SECRET, "hex"),
  dataKey: Buffer.from(parsed.data.DATA_SECRET, "hex"),
};

if (env.isProd) {
  if (env.origins.some((o) => !o.startsWith("https://"))) throw new Error("ALLOWED_ORIGINS must all be https:// in production");
  if (env.tunnelKey.equals(env.dataKey)) throw new Error("TUNNEL_SECRET and DATA_SECRET must be different");
}
