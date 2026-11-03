// lib/checkout/intent-api-http.js — Stage E6 (offline; Stripe TEST mode only). HTTP layer of the intent API.
//
// Routes (api/checkout/intents.js, api/checkout/intent-step.js) call createIntentApiHandler(). Order of checks, each one
// refusing before the next runs (and before any SDK, pool, Hostaway or database effect):
//   1. intentApiGate(env): production / no flag / incomplete TEST configuration -> 404.
//   2. Exact-origin CORS: Origin must equal MV_CHECKOUT_ALLOWED_ORIGIN, else 403 (no CORS headers). OPTIONS -> 204.
//   3. No query string at all (tokens and data never travel in URLs) -> 400. Method per route -> 405.
//   4. POST: application/json, bounded raw body (8 KiB, 10 s), strict JSON object -> 415/413/408/400.
//   5. Bearer token (where required): exactly 43 base64url chars (256 bits), canonical -> else uniform 401.
//   6. Lazily: pool (database must be marked 'test'), then shared rate limits (database, all workers; per trusted client
//      address or one shared unattributed bucket, see clientAddress), then the intent
//      by SHA-256(token) (unknown -> the SAME 401), then the operation (lib/checkout/intent-api-core.js, lazy).
// Responses: JSON { code } or the documented status bodies; Cache-Control no-store. Logs: codes only.
import { createHash, createHmac } from "node:crypto";
import { isIP } from "node:net";
import { stripeTestGate } from "./stripe-test-mode.js";
import { readBoundedBody } from "./stripe-webhook-http.js";

export const MAX_JSON_BYTES = 8 * 1024;
export const BODY_DEADLINE_MS = 10000;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const ORIGIN_RE = /^https:\/\/[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+(:\d{1,5})?$/;
const LISTING_RE = /^([1-9]\d{0,11}):(MXN|USD)$/;
const TERMS_RE = /^[a-z0-9][a-z0-9.-]{0,39}$/;

function validReturnUrl(u) {
  if (typeof u !== "string" || !u || u.length > 500) return false;
  let x; try { x = new URL(u); } catch { return false; }
  return x.protocol === "https:" && !x.username && !x.password && !x.search && !x.hash;
}

/** Parse "603566:MXN,606998:USD" (1..10 distinct TEST listings, each with its server-side currency). */
export function parseTestListings(raw) {
  if (typeof raw !== "string" || !raw || raw.length > 400) return null;
  const m = new Map();
  for (const part of raw.split(",")) {
    const x = LISTING_RE.exec(part.trim());
    if (!x || m.has(Number(x[1]))) return null;
    m.set(Number(x[1]), Object.freeze({ currency: x[2] }));
  }
  return m.size >= 1 && m.size <= 10 ? m : null;
}

/** All E5a TEST settings plus the intent-API settings, or a code. Reads only the env object passed in. */
export function intentApiGate(env) {
  const g = stripeTestGate(env);
  if (!g.ok) return g;
  const e = env;
  if (e.MV_CHECKOUT_TEST_API !== "enabled") return { ok: false, code: "API_NOT_ENABLED" };
  if (typeof e.MV_CHECKOUT_ALLOWED_ORIGIN !== "string" || !ORIGIN_RE.test(e.MV_CHECKOUT_ALLOWED_ORIGIN)) return { ok: false, code: "ALLOWED_ORIGIN_REQUIRED" };
  const listings = parseTestListings(e.MV_CHECKOUT_TEST_LISTINGS);
  if (!listings) return { ok: false, code: "TEST_LISTINGS_REQUIRED" };
  if (typeof e.MV_RATE_LIMIT_SALT !== "string" || e.MV_RATE_LIMIT_SALT.length < 32 || e.MV_RATE_LIMIT_SALT.length > 256) return { ok: false, code: "RATE_LIMIT_SALT_REQUIRED" };
  if (typeof e.MV_CHECKOUT_TERMS_VERSION !== "string" || !TERMS_RE.test(e.MV_CHECKOUT_TERMS_VERSION)) return { ok: false, code: "TERMS_VERSION_REQUIRED" };
  if (!validReturnUrl(g.config.returnUrl)) return { ok: false, code: "RETURN_URL_REQUIRED" };
  const addressSource = e.MV_CLIENT_ADDRESS_SOURCE === undefined || e.MV_CLIENT_ADDRESS_SOURCE === "" ? "none" : e.MV_CLIENT_ADDRESS_SOURCE;
  if (!CLIENT_ADDRESS_SOURCES.includes(addressSource)) return { ok: false, code: "CLIENT_ADDRESS_SOURCE_INVALID" };
  return Object.freeze({ ok: true, config: Object.freeze({ ...g.config, allowedOrigin: e.MV_CHECKOUT_ALLOWED_ORIGIN, listings,
    rateLimitSalt: e.MV_RATE_LIMIT_SALT, termsVersion: e.MV_CHECKOUT_TERMS_VERSION, addressSource }) });
}

/** Bearer token -> 32-byte SHA-256 digest, or null (missing, malformed or non-canonical). */
export function tokenHashFromHeader(h) {
  if (typeof h !== "string" || h.length > 60) return null;
  const m = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(h);
  if (!m) return null;
  const raw = Buffer.from(m[1], "base64url");
  if (raw.length !== 32 || raw.toString("base64url") !== m[1]) return null;
  return hashToken(m[1]);
}
export const hashToken = (t) => createHash("sha256").update(Buffer.from(t, "base64url")).digest();

/**
 * Trusted client-address policy (fail closed). A caller can put any text in X-Forwarded-For / X-Real-IP, so header text
 * is NEVER a rate-limit key by itself.
 *   MV_CLIENT_ADDRESS_SOURCE unset or "none" (default): no per-address attribution at all. Every request counts against
 *     ONE shared bucket ("unattributed", conservative global limit). X-Forwarded-For, X-Real-IP and the socket address
 *     (a platform proxy in serverless hosting) are ignored.
 *   "x-real-ip": the single X-Real-IP header value is used ONLY if it is exactly one canonical IPv4 or IPv6 address
 *     (no list, port, zone, brackets or leading zeros); IPv6 is normalised (lowercase, compressed, IPv4-mapped -> IPv4).
 *     Anything else falls back to the shared bucket. X-Forwarded-For is never read. This value may only be set after the
 *     platform validation gate proves the hosting platform overwrites X-Real-IP with the real client address; that is
 *     UNVERIFIED for Vercel today.
 */
export const CLIENT_ADDRESS_SOURCES = Object.freeze(["none", "x-real-ip"]);

/** Canonical form of one IP address literal, or null. */
export function canonicalAddress(v) {
  if (typeof v !== "string" || v.length === 0 || v.length > 45 || v !== v.trim()) return null;
  const kind = isIP(v);
  if (kind === 4) return v;                                   // node:net rejects leading zeros, ports and lists
  if (kind !== 6 || v.includes("%")) return null;              // zone ids are local-only: refused
  let host;
  try { host = new URL(`http://[${v}]/`).hostname.slice(1, -1); } catch { return null; }
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host);
  if (mapped) {
    const hi = parseInt(mapped[1], 16), lo = parseInt(mapped[2], 16);
    return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  }
  return host;
}

/** { trusted:true, address } from the configured adapter, or { trusted:false } (shared fallback). */
export function clientAddress(req, source) {
  if (source !== "x-real-ip") return { trusted: false };
  const h = req.headers["x-real-ip"];
  const a = canonicalAddress(typeof h === "string" ? h : null);
  return a ? { trusted: true, address: a } : { trusted: false };
}

/** Rate limits: [windowSeconds, max]. Defaults; tests may pass smaller ones through deps.limits. */
export const DEFAULT_LIMITS = Object.freeze({
  perAddress: Object.freeze([600, 120]),       // trusted address, all actions
  unattributed: Object.freeze([600, 600]),     // every request without a trusted address, together
  createPerAddress: Object.freeze([600, 10]),
  createUnattributed: Object.freeze([600, 60]),
  createAll: Object.freeze([3600, 300]),
  perToken: Object.freeze([600, 40])
});

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(body === undefined ? "" : JSON.stringify(body));
}

const ROUTES = Object.freeze({
  intents: Object.freeze({ methods: ["GET", "POST"] }),
  step: Object.freeze({ methods: ["POST"] })
});

const defaultDeps = Object.freeze({
  loadCore: async () => import("./intent-api-core.js"),
  loadPoolLib: async () => import("../booking-db/pool.js"),
  loadAccess: async () => import("../booking-db/intent-access.js"),
  loadStripe: async () => (await import("stripe")).default,
  loadHostaway: async () => { const h = await import("../hostaway.js"); return { get: h.hostawayGet, post: h.hostawayPost }; },
  now: () => Date.now(),
  log: (code) => console.warn(`[intent-api] ${code}`)
});

/** createIntentApiHandler({ route: "intents"|"step", env, deps? }) */
export function createIntentApiHandler({ route, env, deps = {} }) {
  const spec = ROUTES[route];
  if (!spec) throw new TypeError("route");
  const d = { ...defaultDeps, ...deps };
  let ready = null; // { pool, access, core, accountCache, stripe? }
  return async function handler(req, res) {
    const gate = intentApiGate(env);
    if (!gate.ok) return send(res, 404, { code: "NOT_FOUND" });
    const cfg = gate.config;
    const origin = req.headers.origin;
    if (origin !== cfg.allowedOrigin) return send(res, 403, { code: "ORIGIN_NOT_ALLOWED" });
    res.setHeader("Access-Control-Allow-Origin", cfg.allowedOrigin);
    res.setHeader("Vary", "Origin");
    if (req.method === "OPTIONS") {
      res.setHeader("Access-Control-Allow-Methods", [...spec.methods, "OPTIONS"].join(", "));
      res.setHeader("Access-Control-Allow-Headers", "authorization, content-type");
      res.setHeader("Access-Control-Max-Age", "600");
      return send(res, 204);
    }
    if (typeof req.url === "string" && req.url.includes("?")) return send(res, 400, { code: "QUERY_NOT_ALLOWED" });
    if (!spec.methods.includes(req.method)) { res.setHeader("Allow", [...spec.methods, "OPTIONS"].join(", ")); return send(res, 405, { code: "METHOD_NOT_ALLOWED" }); }

    let body = null;
    if (req.method === "POST") {
      const ct = String(req.headers["content-type"] || "").toLowerCase();
      if (!/^application\/json(\s*;\s*charset=utf-8)?$/.test(ct)) return send(res, 415, { code: "JSON_REQUIRED" });
      const declared = req.headers["content-length"];
      if (declared !== undefined && !(Number(declared) >= 0 && Number(declared) <= MAX_JSON_BYTES)) {
        if (typeof req.resume === "function") req.resume();
        return send(res, 413, { code: "BODY_TOO_LARGE" });
      }
      let raw;
      try { raw = await readBoundedBody(req, MAX_JSON_BYTES, { deadlineMs: d.bodyDeadlineMs ?? BODY_DEADLINE_MS }); } catch (e) {
        const st = { BODY_TOO_LARGE: 413, BODY_TIMEOUT: 408 }[e.code] || 400;
        if (!res.writableEnded && !res.destroyed) send(res, st, { code: ["BODY_TOO_LARGE", "BODY_TIMEOUT", "BODY_ABORTED"].includes(e.code) ? e.code : "BODY_READ_FAILED" });
        return;
      }
      try { body = JSON.parse(raw.toString("utf8")); } catch { return send(res, 400, { code: "INVALID_JSON" }); }
      if (body === null || typeof body !== "object" || Array.isArray(body) || Object.getPrototypeOf(body) !== Object.prototype) return send(res, 400, { code: "INVALID_JSON" });
    }

    // which operation, decided before any database access
    let op;
    if (route === "intents") op = req.method === "POST" ? "create" : "status";
    else op = body.step === "details" ? "details" : body.step === "pay" ? "pay" : null;
    if (!op) return send(res, 400, { code: "UNKNOWN_STEP" });
    let tokenHash = null;
    if (op !== "create") {
      tokenHash = tokenHashFromHeader(req.headers.authorization);
      if (!tokenHash) { res.setHeader("WWW-Authenticate", "Bearer"); return send(res, 401, { code: "UNAUTHORIZED" }); }
    }

    try {
      if (!ready) {
        const poolLib = await d.loadPoolLib();
        const pool = d.createPool ? d.createPool(cfg) : poolLib.createBookingPool({ connectionString: cfg.databaseUrl, caPem: cfg.databaseCaPem });
        await poolLib.assertEnvironment(pool, "test");
        ready = { pool, access: await d.loadAccess(), core: await d.loadCore(), accountCache: {}, stripe: null };
      }
    } catch {
      ready = null; d.log("NOT_READY");
      return send(res, 503, { code: "NOT_READY" });
    }
    const bucket = (scope, value) => `${scope}:${createHmac("sha256", cfg.rateLimitSalt).update(`${scope}|${value}`).digest("hex")}`;
    const now = d.now();
    const client = clientAddress(req, cfg.addressSource);
    const L = { ...DEFAULT_LIMITS, ...(d.limits || {}) };
    const hit = (scope, value, [windowSeconds, max]) => ready.access.rateLimitHit(ready.pool, bucket(scope, value), windowSeconds, max);
    const ctx = {
      pool: ready.pool, env, config: cfg, now, accountCache: ready.accountCache, hashToken,
      // creation limits: per trusted address, or one shared bucket for everything unattributed; plus a global cap
      limitCreate: async () => (client.trusted ? await hit("create_ip", client.address, L.createPerAddress) : await hit("create_shared", "all", L.createUnattributed))
        && await hit("create_all", "all", L.createAll),
      hostaway: async () => (d.createHostaway ? d.createHostaway(cfg) : d.loadHostaway()),
      stripe: async () => {
        if (!ready.stripe) {
          if (d.createStripe) ready.stripe = d.createStripe(cfg);
          else { const Stripe = await d.loadStripe(); ready.stripe = new Stripe(cfg.secretKey, { maxNetworkRetries: 0, timeout: 10000 }); }
        }
        return ready.stripe;
      }
    };
    try {
      const ok = client.trusted ? await hit("ip", client.address, L.perAddress) : await hit("unattributed", "all", L.unattributed);
      if (!ok) return send(res, 429, { code: "RATE_LIMITED" });
      let out;
      if (op === "create") out = await ready.core.createCheckoutIntent(ctx, body);
      else {
        if (!(await hit("tok", tokenHash.toString("hex"), L.perToken))) return send(res, 429, { code: "RATE_LIMITED" });
        const intentId = await ready.access.findIntentIdByTokenHash(ready.pool, tokenHash);
        if (!intentId) { res.setHeader("WWW-Authenticate", "Bearer"); return send(res, 401, { code: "UNAUTHORIZED" }); }
        if (op === "status") out = await ready.core.intentStatus(ctx, intentId);
        else if (op === "details") out = await ready.core.submitDetails(ctx, intentId, body);
        else out = await ready.core.payIntent(ctx, intentId, body);
      }
      if (out.http >= 400) d.log(out.body.code);
      return send(res, out.http, out.body);
    } catch (e) {
      if (typeof d.onError === "function") d.onError(e);          // tests only; never wired to a logger in routes
      d.log(`FAILED_${op.toUpperCase()}`);
      return send(res, 503, { code: "UNAVAILABLE" });
    }
  };
}
