// public/manage.js — M1 "Manage my booking" (owner decision 2026-11-27): the guest finds their own booking with the booking reference and the
// e-mail they booked with (the airline model) and sees a READ-ONLY summary. Changes and cancellations are REQUESTS by e-mail to the host;
// nothing on this page changes, cancels or refunds a booking. The reference may arrive in the URL fragment (#MV-XXXXXXXX), which browsers
// never send to a server; the e-mail is always typed. Nothing is stored in the browser. Same-origin only (the page's CSP allows nothing else).
export const SUPPORT_EMAIL = "info@micasadirect.com";
const REF_RE = /^MV-[A-Z0-9]{6,10}$/;
const EMAIL_RE = /^[^@\s]{1,64}@[^@\s]{1,189}\.[^@\s]{1,24}$/;

/** "mv z6kv-455m " -> "MV-Z6KV455M" (null when it cannot be a booking reference). */
export function normalizeRef(raw) {
  if (typeof raw !== "string") return null;
  const t = raw.trim().toUpperCase().replace(/^#/, "").replace(/[\s-]+/g, "");
  const ref = t.startsWith("MV") ? `MV-${t.slice(2)}` : `MV-${t}`;
  return REF_RE.test(ref) ? ref : null;
}
export function normalizeEmail(raw) {
  if (typeof raw !== "string") return null;
  const e = raw.trim();
  return e.length >= 3 && e.length <= 254 && EMAIL_RE.test(e) ? e : null;
}
export function refFromHash(hash) { return typeof hash === "string" && hash.length > 1 ? normalizeRef(hash.slice(1)) : null; }

export const NOTICES = Object.freeze({
  INPUT: "Please check the booking reference (it starts with MV-) and the email address.",
  BOOKING_NOT_FOUND: "We could not find a confirmed booking with that reference and email. Check both against your confirmation email. If you paid in the last few minutes, your booking may still be confirming.",
  RATE_LIMITED: "Too many tries. Please wait a few minutes and try again.",
  UNAVAILABLE: "We could not check right now. Please try again in a moment."
});
/** One lookup. Returns { ok:true, booking } or { ok:false, notice } (a NOTICES key). Never throws. */
export async function lookup(fetchFn, ref, email) {
  let res;
  try {
    res = await fetchFn("/api/checkout/intent-step", { method: "POST", headers: { "Content-Type": "application/json" }, cache: "no-store",
      credentials: "omit", referrerPolicy: "no-referrer", body: JSON.stringify({ step: "lookup", ref, email }) });
  } catch { return { ok: false, notice: "UNAVAILABLE" }; }
  if (res.status === 404) return { ok: false, notice: "BOOKING_NOT_FOUND" };
  if (res.status === 429) return { ok: false, notice: "RATE_LIMITED" };
  if (res.status === 400) return { ok: false, notice: "INPUT" };
  if (res.status !== 200) return { ok: false, notice: "UNAVAILABLE" };
  let body; try { body = await res.json(); } catch { return { ok: false, notice: "UNAVAILABLE" }; }
  const b = body && body.booking;
  if (!b || typeof b !== "object" || !REF_RE.test(String(b.ref)) || !["complete", "cancelled"].includes(b.stage) || !/^\d{4}-\d{2}-\d{2}$/.test(String(b.from))
    || !/^\d{4}-\d{2}-\d{2}$/.test(String(b.to)) || !Number.isInteger(b.guests) || !Number.isInteger(b.listingId)) return { ok: false, notice: "UNAVAILABLE" };
  return { ok: true, booking: b };
}

export function formatMoney(minor, currency) {
  try { return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(minor / 100); } catch { return `${(minor / 100).toFixed(2)} ${currency}`; }
}
export const longDate = (iso) => { try { return new Intl.DateTimeFormat("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric", timeZone: "UTC" }).format(new Date(`${iso}T00:00:00Z`)); } catch { return iso; } };
export const nightsBetween = (from, to) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000);
export const REFUND_TEXT = Object.freeze({ pending: "Refund: being arranged. We will confirm by email.", none: "Refund: none under the cancellation policy.",
  partial: "Refund: a partial refund has been made.", full: "Refund: a full refund has been made." });
/** What the booking section shows (pure). `homeName` is null when the public listing feed could not name the home. */
export function viewOf(b, homeName) {
  const cancelled = b.stage === "cancelled";
  const price = b.price && Number.isInteger(b.price.totalMinor) && typeof b.price.currency === "string" ? b.price : null;
  return {
    status: cancelled ? "This booking was cancelled." : "Your booking is confirmed.", cancelled,
    ref: b.ref, home: homeName || "Your MiCasaDirect home", checkIn: longDate(b.from), checkOut: longDate(b.to),
    nights: String(nightsBetween(b.from, b.to)), guests: String(b.guests),
    lines: price ? (Array.isArray(price.lines) ? price.lines : []).filter((l) => l && typeof l.label === "string" && Number.isInteger(l.amountMinor))
      .map((l) => `${l.label}: ${formatMoney(l.amountMinor, price.currency)}`) : [],
    total: price ? `Total paid: ${formatMoney(price.totalMinor, price.currency)}` : null,
    refund: cancelled && typeof b.refundStatus === "string" && Object.hasOwn(REFUND_TEXT, b.refundStatus) ? REFUND_TEXT[b.refundStatus] : null
  };
}
/** mailto: link for a request to the host. The body names the booking only (no personal data beyond what the guest types). */
export function requestLink(kind, v) {
  const subject = `${kind === "cancel" ? "Cancellation request" : "Change request"}: ${v.ref}`;
  const body = `Booking reference: ${v.ref}\nHome: ${v.home}\nCheck-in: ${v.checkIn}\nCheck-out: ${v.checkOut}\n\n${kind === "cancel" ? "I would like to cancel this booking." : "I would like to change this booking. The change I need:"}\n`;
  return `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}
/** The home's public name from the same-origin listing feed (null on any problem; the page then shows a neutral label). */
export async function homeNameOf(fetchFn, listingId) {
  try {
    const r = await fetchFn("/api/booking/listings", { method: "GET", credentials: "omit" });
    if (r.status !== 200) return null;
    const j = await r.json();
    const l = (Array.isArray(j && j.listings) ? j.listings : []).find((x) => x && x.id === listingId);
    return l && typeof l.name === "string" && l.name.length <= 120 ? l.name : null;
  } catch { return null; }
}

export function startManage(doc, win) {
  const $ = (id) => doc.getElementById(id);
  const show = (id, on) => { $(id).hidden = !on; };
  const notice = (key) => { const n = $("mg-notice"); if (!key) { n.hidden = true; n.textContent = ""; return; } n.textContent = NOTICES[key]; n.dataset.level = key === "INPUT" || key === "BOOKING_NOT_FOUND" ? "warn" : "error"; n.hidden = false; };
  const fetchFn = win.fetch.bind(win);
  fetchFn("/api/checkout/config", { method: "GET", credentials: "omit" }).then((r) => (r.status === 200 ? r.json() : null)).then((c) => { if (c && c.mode === "test") show("mv-test-banner", true); }).catch(() => {});
  const pre = refFromHash(win.location.hash);
  if (pre) $("mg-ref").value = pre;
  let busy = false;
  $("mg-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (busy) return;
    const ref = normalizeRef($("mg-ref").value), email = normalizeEmail($("mg-email").value);
    if (!ref || !email) return notice("INPUT");
    busy = true; $("mg-submit").disabled = true; $("mg-submit").textContent = "Checking…"; notice(null);
    const r = await lookup(fetchFn, ref, email);
    busy = false; $("mg-submit").disabled = false; $("mg-submit").textContent = "Find my booking";
    if (!r.ok) return notice(r.notice);
    const v = viewOf(r.booking, await homeNameOf(fetchFn, r.booking.listingId));
    $("mg-status").textContent = v.status; $("mg-status").dataset.cancelled = String(v.cancelled);
    $("mg-f-ref").textContent = v.ref; $("mg-f-home").textContent = v.home; $("mg-f-in").textContent = v.checkIn; $("mg-f-out").textContent = v.checkOut;
    $("mg-f-nights").textContent = v.nights; $("mg-f-guests").textContent = v.guests;
    const ul = $("mg-price"); ul.replaceChildren();
    for (const t of v.lines) { const li = doc.createElement("li"); li.textContent = t; ul.append(li); }
    if (v.total) { const li = doc.createElement("li"); li.className = "total"; li.textContent = v.total; ul.append(li); }
    $("mg-refund").textContent = v.refund || ""; show("mg-refund", !!v.refund);
    show("mg-actions", !v.cancelled);
    $("mg-change").href = requestLink("change", v); $("mg-cancel").href = requestLink("cancel", v);
    show("mg-form", false); show("mg-intro", false); show("mg-booking", true);
    $("mg-title").textContent = "My booking"; $("mg-title").focus();
  });
  $("mg-again").addEventListener("click", () => { $("mg-email").value = ""; show("mg-booking", false); show("mg-form", true); show("mg-intro", true); $("mg-title").textContent = "Find my booking"; notice(null); $("mg-ref").focus(); });
}

if (typeof document !== "undefined" && document.getElementById("mv-manage")) startManage(document, window);
