import { env } from "../config/env.js";
import { forbidden } from "../lib/errors.js";

/**
 * CORS, only for our own sites (ALLOWED_ORIGINS). A site served as static files calls the API on
 * another subdomain of the same parent domain, so the browser asks first; anyone else gets no CORS
 * headers, and the browser blocks them. Cookies stay SameSite=Lax, so they only travel between
 * sites that share a parent domain.
 */
export function corsForOurSites(req, res, next) {
  const origin = (req.get("origin") ?? "").replace(/\/$/, "");
  if (!origin || !env.origins.includes(origin)) return req.method === "OPTIONS" ? res.status(204).end() : next();
  res.vary("Origin");
  res.set({ "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Credentials": "true" });
  if (req.method !== "OPTIONS") return next();
  res.set({ "Access-Control-Allow-Methods": "POST", "Access-Control-Allow-Headers": "content-type, x-ps-client, x-ps-kid", "Access-Control-Max-Age": "600" });
  res.status(204).end();
}

/**
 * CSRF defence for the tunnel: the call must come from one of our sites. Browsers set
 * Origin and Sec-Fetch-Site themselves and page scripts cannot change them; the custom
 * header forces a CORS preflight, which this API approves only for our own sites.
 */
export function sameSiteOnly(req, _res, next) {
  const origin = (req.get("origin") ?? "").replace(/\/$/, "");
  const fetchSite = req.get("sec-fetch-site");
  if (req.get("x-ps-client") !== "web") return next(forbidden("Request blocked."));
  if (!origin || !env.origins.includes(origin)) return next(forbidden("Request blocked."));
  if (fetchSite && !["same-origin", "same-site"].includes(fetchSite)) return next(forbidden("Request blocked."));
  next();
}

/** Rejects keys that could become Mongo operators or pollute prototypes, at any depth. */
export function rejectDangerousKeys(req, _res, next) {
  const walk = (v, depth = 0) => {
    if (depth > 12) throw forbidden("Request blocked.");
    if (Array.isArray(v)) return v.forEach((x) => walk(x, depth + 1));
    if (v && typeof v === "object") {
      for (const k of Object.keys(v)) {
        if (k.startsWith("$") || k.includes(".") || k === "__proto__" || k === "constructor" || k === "prototype") throw forbidden("Request blocked.");
        walk(v[k], depth + 1);
      }
    }
  };
  try {
    walk(req.body);
    walk(req.query);
    next();
  } catch (e) {
    next(e);
  }
}
