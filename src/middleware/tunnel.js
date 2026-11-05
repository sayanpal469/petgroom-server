import crypto from "node:crypto";
import { env } from "../config/env.js";
import { seal, unseal } from "../lib/crypto.js";
import { ApiError } from "../lib/errors.js";

/**
 * Encrypted API tunnel.
 *
 * The browser makes an ECDH handshake, then sends every call as one POST to /api/v1/t
 * with the real method, path and body inside AES-256-GCM. The network tab shows a single
 * URL and ciphertext. This hides traffic from casual inspection and from anything that
 * logs requests along the way. It is not access control: a user can still read their own
 * browser's memory, so permissions are enforced by the routes behind the tunnel.
 *
 * The key is sealed into `kid` with TUNNEL_SECRET, so any API instance can read it and no
 * shared session store is needed.
 */
const KEY_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_SKEW_MS = 5 * 60 * 1000;
const REQ_AAD = Buffer.from("req");
const RES_AAD = Buffer.from("res");

/** Prefix for paths inside the tunnel, so nothing behind it can be reached with a plain request. */
export const INNER_PREFIX = "/__inner";

export function handshake(req, res) {
  let reply;
  try {
    const ecdh = crypto.createECDH("prime256v1");
    ecdh.generateKeys();
    const secret = ecdh.computeSecret(Buffer.from(String(req.body?.pub ?? ""), "base64"));
    const salt = crypto.randomBytes(16);
    const key = Buffer.from(crypto.hkdfSync("sha256", secret, salt, "paws-tunnel-v1", 32));
    const exp = Date.now() + KEY_TTL_MS;
    const kid = seal(Buffer.concat([Buffer.from(String(exp).padStart(16, "0")), key]), env.tunnelKey);
    reply = { pub: ecdh.getPublicKey("base64"), salt: salt.toString("base64"), kid, exp, now: Date.now() };
  } catch {
    throw new ApiError(400, "Bad handshake.", "bad_handshake");
  }
  res.set("Cache-Control", "no-store").json(reply);
}

function openKid(kid) {
  try {
    const raw = unseal(kid, env.tunnelKey);
    if (Number(raw.subarray(0, 16).toString()) < Date.now()) return null;
    return raw.subarray(16);
  } catch {
    return null;
  }
}

function encrypt(key, value) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key, iv);
  c.setAAD(RES_AAD);
  const body = Buffer.concat([c.update(Buffer.from(JSON.stringify(value))), c.final(), c.getAuthTag()]);
  return { iv: iv.toString("base64"), d: body.toString("base64") };
}

function decrypt(key, iv, data) {
  const raw = Buffer.from(data, "base64");
  const d = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64"));
  d.setAAD(REQ_AAD);
  d.setAuthTag(raw.subarray(raw.length - 16));
  return JSON.parse(Buffer.concat([d.update(raw.subarray(0, raw.length - 16)), d.final()]).toString());
}

export function tunnel(req, res, next) {
  const key = openKid(String(req.get("x-ps-kid") ?? ""));
  if (!key) return res.status(428).json({ error: { code: "rekey", message: "Session key expired." } });

  const reject = () => res.status(400).json({ error: { code: "bad_payload", message: "Unreadable request." } });
  let call;
  try {
    call = decrypt(key, String(req.body?.iv), String(req.body?.d));
  } catch {
    return reject();
  }
  const method = String(call.m ?? "").toUpperCase();
  const path = String(call.p ?? "");
  if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(method) || !path.startsWith("/") || path.startsWith("//") || path.includes("..") || path.includes("\\")) {
    return reject();
  }
  if (Math.abs(Date.now() - Number(call.t)) > MAX_SKEW_MS) {
    return res.status(428).json({ error: { code: "rekey", message: "Session key expired." } });
  }

  // Every reply goes out encrypted with HTTP 200, so the status code is hidden as well.
  res.json = (value) => {
    const status = res.statusCode;
    res.locals.realStatus = status;
    res.statusCode = 200;
    res.set("Cache-Control", "no-store");
    res.type("application/json");
    res.end(JSON.stringify(encrypt(key, { s: status, b: value ?? null })));
    return res;
  };

  req.method = method;
  req.url = `${INNER_PREFIX}${path}`;
  req.body = call.b ?? {};
  req.tunneled = true;
  next();
}

/** Blocks a plain HTTP request that tries to use an inner path directly. */
export function tunneledOnly(req, _res, next) {
  if (!req.tunneled) return next(new ApiError(404, "Not found.", "not_found"));
  next();
}
