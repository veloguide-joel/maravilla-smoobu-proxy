// Shared guard for the Hostaway diagnostic endpoints.
// Requires header `x-admin-key` equal to env HOSTAWAY_DIAG_KEY, compared in
// constant time (sha256 both sides so lengths match before timingSafeEqual).
// Returns true if the request may proceed; otherwise writes the response and
// returns false. Never logs the presented or expected key.

import { createHash, timingSafeEqual } from "node:crypto";

function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

export function requireDiagKey(req, res) {
  const expected = process.env.HOSTAWAY_DIAG_KEY;
  if (!expected) {
    res.status(503).json({ ok: false, error: "DIAGNOSTIC_DISABLED" });
    return false;
  }
  const presented = req.headers["x-admin-key"];
  const presentedStr = Array.isArray(presented) ? presented[0] : presented;
  if (!safeEqual(presentedStr, expected)) {
    res.status(401).json({ ok: false, error: "UNAUTHORIZED" });
    return false;
  }
  return true;
}
