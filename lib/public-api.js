// lib/public-api.js — shared helpers for the public /api/booking/* routes
// (Stage F1/F2). Keeps the CORS allowlist and the deadline helper in exactly
// one place so every public route applies the same policy.

const DEFAULT_ALLOWED_ORIGINS = Object.freeze([
  "https://maravilla-booking-ui-git-dev-joel-goralskis-projects.vercel.app", // booking-ui DEV preview
  "http://localhost:5500",   // local static server used by the UI's own scripts
  "http://127.0.0.1:5500"
]);

export const PROPERTY_TIME_ZONE = "America/Mexico_City"; // both pilots (Stage B: timeZoneName)

/** Allowlist = defaults + BOOKING_UI_ORIGINS (comma-separated origins). Never a wildcard. */
export function allowedOrigins() {
  const extra = typeof process.env.BOOKING_UI_ORIGINS === "string"
    ? process.env.BOOKING_UI_ORIGINS.split(",").map((s) => s.trim()).filter((s) => /^https?:\/\/[a-z0-9.-]+(:\d+)?$/i.test(s))
    : [];
  return new Set([...DEFAULT_ALLOWED_ORIGINS, ...extra]);
}

/**
 * Sets CORS headers only for allowlisted origins; always sets Vary: Origin.
 * Returns true when the request origin is allowed.
 */
export function applyPublicCors(req, res) {
  const origin = req.headers.origin;
  res.setHeader("Vary", "Origin");
  if (typeof origin === "string" && allowedOrigins().has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Accept");
    res.setHeader("Access-Control-Max-Age", "600");
    return true;
  }
  return false;
}

/** Rejects with { code: "DEADLINE" } if `promise` does not settle within `ms`. */
export function withDeadline(promise, ms, label = "request") {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error(`${label} deadline`), { code: "DEADLINE" })), ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

/** "YYYY-MM-DD" for the current date in the given IANA time zone. */
export function todayInTimeZone(timeZone = PROPERTY_TIME_ZONE, now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const get = (t) => parts.find((p) => p.type === t)?.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}
