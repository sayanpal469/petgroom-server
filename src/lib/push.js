import { env } from "../config/env.js";
import { Settings } from "../models/index.js";
import { seal, unseal } from "./crypto.js";
import { logger } from "./logger.js";

/**
 * Push notifications through OneSignal. Every in-app notification (see `notify` in misc.js) is also
 * sent as a push to the phones where that user is logged in to the app. The app logs in to OneSignal
 * with the user's id as its external id, so the server targets users by id and never handles tokens.
 *
 * The App ID is public (the app needs it); the App API key is sealed with DATA_SECRET and never
 * sent back to a browser. Both are set from the admin panel: Settings > Push notifications.
 */
const BASE = "https://api.onesignal.com";
const CACHE_MS = env.isTest ? 0 : 15_000;
const DEFAULTS = { enabled: false, appId: "", keySealed: "" };
const ACCENT = "FFF5B800";

let cached = null;
let cachedAt = 0;

export async function getPushConfig() {
  if (cached && Date.now() - cachedAt < CACHE_MS) return cached;
  const doc = await Settings.findById("push").lean();
  cached = { ...DEFAULTS, ...(doc?.data ?? {}) };
  cachedAt = Date.now();
  return cached;
}

export async function savePushConfig({ apiKey, ...patch }) {
  const next = { ...(await getPushConfig()), ...patch };
  if (apiKey) next.keySealed = seal(Buffer.from(apiKey));
  await Settings.updateOne({ _id: "push" }, { $set: { data: next } }, { upsert: true });
  cached = next;
  cachedAt = Date.now();
  return next;
}

export const pushView = (c) => ({ enabled: c.enabled, appId: c.appId, hasKey: Boolean(c.keySealed) });
export const pushReady = (c) => c.enabled && Boolean(c.appId) && Boolean(c.keySealed);

/** Tests replace the network call; production always talks to OneSignal. */
let transport = async (url, init) => {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(10_000) });
  return { status: res.status, body: await res.json().catch(() => null) };
};
export const setPushTransport = (fn) => {
  transport = fn;
};

const call = (c, method, path, body) =>
  transport(`${BASE}${path}`, {
    method,
    headers: { authorization: `Key ${unseal(c.keySealed).toString()}`, "content-type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

/** Used by the Test button: a wrong App ID or key gets 400/401/403. */
export async function testPushKeys(c) {
  const { status } = await call(c, "GET", `/notifications?app_id=${encodeURIComponent(c.appId)}&limit=1`);
  if (status >= 400) throw new Error(`onesignal ${status}`);
}

/** Sends one push to the given users. Resolves to OneSignal's answer; throws on a refused request. */
export async function sendPush(c, userIds, { title, message, data }) {
  const { status, body } = await call(c, "POST", "/notifications?c=push", {
    app_id: c.appId,
    target_channel: "push",
    include_aliases: { external_id: userIds.map(String) },
    headings: { en: title || "Paws Station" },
    contents: { en: message || title || "" },
    data,
    android_accent_color: ACCENT,
    small_icon: "ic_stat_onesignal_default",
    priority: 10,
  });
  if (status >= 400) throw new Error(`onesignal ${status}: ${JSON.stringify(body?.errors ?? body)}`);
  return body;
}

/** Fire and forget, like the notification it mirrors: a push failure never breaks the action. */
export function pushToUser(userId, n) {
  getPushConfig()
    .then((c) => {
      if (!pushReady(c)) return;
      return sendPush(c, [userId], { title: n.title, message: n.message, data: { kind: n.kind ?? "booking", href: n.href ?? "" } });
    })
    .catch((err) => logger.warn({ err: err.message }, "push send failed"));
}
