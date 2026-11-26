// public/checkout.js -- the guest checkout page (P4-1). Same-origin static page; talks only to /api/checkout/* on its own origin.
//
// The booking logic is NOT duplicated: the controller, API client and tab store are the ones in checkout-test.js (create -> details ->
// pay -> status, the single-intent rule, uncertainty latches, bounded polling). This file supplies what a guest page needs on top:
//   * the stay comes from the link the guest followed: ?listing=<id>&from=YYYY-MM-DD&to=YYYY-MM-DD&guests=<n>[&name=<property name>]
//     (strictly validated; the server prices and decides everything, these values only start the request);
//   * guest wording for every screen (no test wording), the price with its Taxes line, and the cancellation policy shown before payment --
//     the same sentences as the confirmation email (CANCELLATION_POLICY below must equal lib/checkout/booking-confirmation-copy.js; a test
//     compares them);
//   * no release / operator controls.
// Nothing here is proof of a payment or a booking: every status shown comes from the server's reply.
import { createApi, createController, createStore, announcementFor, stopLine, supportCode } from "./checkout-test.js";

export const BRAND = "MiCasaDirect";
export const CANCELLATION_CONTACT = "info@micasadirect.com";
export const CANCELLATION_POLICY = Object.freeze([
  `To cancel, email ${CANCELLATION_CONTACT} with your booking reference.`,
  "90 days or more before arrival: we refund the amount you paid, including taxes, less a cancellation fee of US$250 plus 16% IVA (US$290 in total).",
  "89 days or fewer before arrival: no refund. The amount you paid, less the same US$290 fee, becomes a credit toward a new stay at the same property. The new stay must begin within one year of your original arrival date. The credit cannot be used at any other property."
]);
export const CONFIG_PATH = "/api/checkout/config";
export const RETURN_HINTS = Object.freeze(["?checkout=complete", "?checkout=cancelled"]);
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 86_400_000;
const BOOKING_REF_RE = /Booking reference: (MV-[A-Z0-9]{6,10})\b/;

const dayMs = (s) => {
  const m = typeof s === "string" ? DATE_RE.exec(s) : null;
  if (!m) return null;
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const d = new Date(t);
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]) ? t : null;
};

/** Parse the stay link. -> { ok:true, stay:{ listingId, from, to, guests, nights, name|null } } | { ok:false, code } | null (no stay parameters). */
export function parseStayQuery(search) {
  if (typeof search !== "string" || search.length > 600 || search === "" || RETURN_HINTS.includes(search)) return null;
  let q; try { q = new URLSearchParams(search); } catch { return { ok: false, code: "LINK_INVALID" }; }
  const keys = [...q.keys()];
  if (keys.some((k) => !["listing", "from", "to", "guests", "name"].includes(k)) || new Set(keys).size !== keys.length) return { ok: false, code: "LINK_INVALID" };
  const listing = q.get("listing") || ""; const guests = q.get("guests") || "";
  if (!/^[1-9]\d{0,11}$/.test(listing)) return { ok: false, code: "LISTING_INVALID" };
  const a = dayMs(q.get("from")); const b = dayMs(q.get("to"));
  if (a === null || b === null || !(b > a) || (b - a) / DAY_MS > 365) return { ok: false, code: "DATES_INVALID" };
  if (!/^[1-9]\d?$/.test(guests) || Number(guests) > 50) return { ok: false, code: "GUESTS_INVALID" };
  const rawName = q.get("name");
  const name = typeof rawName === "string" && /^[^\u0000-\u001f\u007f<>]{1,80}$/.test(rawName.trim()) ? rawName.trim() : null;
  return { ok: true, stay: Object.freeze({ listingId: Number(listing), from: q.get("from"), to: q.get("to"), guests: Number(guests), nights: (b - a) / DAY_MS, name }) };
}

/** Guest wording for a controller view. The controller's own (test-worded) title / text are never shown. -> { title, text } */
export function guestCopy(v) {
  const ref = typeof v.text === "string" && BOOKING_REF_RE.test(v.text) ? BOOKING_REF_RE.exec(v.text)[1] : null;
  switch (v.screen) {
    case "create": return { title: "Your stay", text: "Check the details below, then continue to see the total price." };
    case "loading": return { title: "One moment…", text: "" };
    case "details": return { title: "Your details", text: "Review the total, then enter your details. Nothing is charged at this step." };
    case "pay": return { title: "Ready for payment", text: "Continue to our secure payment page (Stripe) to pay by card. If you have already paid, use Refresh status instead of paying again." };
    case "redirecting": return { title: "Opening the secure payment page…", text: "" };
    case "payWait": return { title: "Checking your payment", text: "You are back from the payment page. We are confirming the result with our system. Please do not pay again; use Refresh status in a moment." };
    case "authorized": case "confirming": return { title: "We are confirming your booking",
      text: "Your payment details were received and we are now confirming the reservation. This usually takes a few minutes. Please do not pay again. You can keep this page open and use Refresh status; we also email you when the booking is confirmed." };
    case "finalizing": return { title: "Payment received — finishing your booking", text: "Your payment was received and the booking is being completed. Please do not pay again. Use Refresh status in a moment." };
    case "complete": return { title: "Your booking is confirmed", text: `Thank you. Your reservation is confirmed and your payment was received.${ref ? ` Booking reference: ${ref}.` : ""} A confirmation email is on its way.` };
    case "terminal": return { title: "This booking was not completed", text: "This booking request is closed. If a payment was not completed, you were not charged. You can start again from the property page." };
    case "review": return { title: "We need to check this booking", text: `We could not confirm this booking automatically. Please do not pay again. Our team will review it; you can write to ${CANCELLATION_CONTACT} with the support code shown below.` };
    case "lost": return { title: "This page can no longer check this booking", text: `If you completed a payment, you will receive an email from us. If in doubt, write to ${CANCELLATION_CONTACT}.` };
    case "unreadable": case "notChecked": case "unexpected": return { title: "Status not confirmed", text: "We could not read the current status. Please wait a moment, then use Refresh status." };
    case "createUncertain": return { title: "We could not confirm your request", text: "Your request may or may not have reached us. Before starting again, wait a moment so that two requests are not made." };
    default: return { title: "Status not confirmed", text: "Please use Refresh status." };
  }
}
/** P4-1b: the guest followed a Book now link while this tab still shows an earlier, FINISHED booking (confirmed or closed). Only then
 *  is "Book this new stay" offered; a booking that is still in progress is never replaced from here. */
export const FINISHED_SCREENS = Object.freeze(["complete", "terminal"]);
export const offerNewStay = (screen, stay) => !!stay && FINISHED_SCREENS.includes(screen);

/** rare technical notices come from the shared controller: drop its test wording, keep the meaning */
// P4-6: the controller's refusal notices are written for an operator; the guest reads these instead (the support code line is unchanged).
const HELP = "If it keeps happening, email info@micasadirect.com with the support code below.";
export const GUEST_REFUSALS = Object.freeze({
  "The server refused the request (a definite refusal).": `We couldn't continue with this booking. Please try again in a moment. ${HELP}`,
  "The server refused the details (a definite refusal).": `We couldn't save your details. Please check them and try again. ${HELP}`,
  "The server refused to start payment (a definite refusal).": `We couldn't open the payment page. Nothing was charged. Please try again in a moment. ${HELP}`,
  "The server refused the release request (a definite refusal).": `We couldn't release this booking request. ${HELP}`
});
// P4-7: refusals that trying again cannot fix (the listing or these dates cannot be booked online). The price button is hidden for them.
export const UNBOOKABLE_CODES = Object.freeze(["LISTING_NOT_AVAILABLE", "LISTING_NOT_CONFIGURED", "NOT_AVAILABLE"]);
export const UNBOOKABLE_TEXT = "This stay can't be booked online right now. Please go back and choose different dates or another property, or email info@micasadirect.com.";
export const isUnbookable = (notice) => !!notice && UNBOOKABLE_CODES.includes(notice.code);
// P4-8: coming back from the payment page. The screen title already says what is happening, so "complete" shows no extra notice
// and no support code; "cancelled" gets one plain line.
export const RETURN_NOTICES = Object.freeze({ RETURNED_COMPLETE: "", RETURNED_CANCELLED: "You left the payment page before paying. You can continue below when you are ready." });
const isReturn = (notice) => !!notice && Object.prototype.hasOwnProperty.call(RETURN_NOTICES, notice.code);
/** The guest's wording for a controller notice ({ text, code }); "" means show no notice. */
export const guestNoticeFor = (notice) => (!notice ? "" : isReturn(notice) ? RETURN_NOTICES[notice.code] : isUnbookable(notice) ? UNBOOKABLE_TEXT : guestNotice(notice.text));
/** Support codes are for refusals and problems, not for the ordinary return from the payment page. */
export const showsSupportCode = (notice) => !!notice && !isReturn(notice);
export const guestNotice = (text) => (typeof text !== "string" ? "" : Object.prototype.hasOwnProperty.call(GUEST_REFUSALS, text) ? GUEST_REFUSALS[text] : text.replace(/\bStripe TEST Checkout\b/g, "the payment page").replace(/\bTEST intent\b/g, "booking request").replace(/\bTEST /g, ""));

function formatMoney(minor, currency) {
  try { return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(minor / 100); } catch { return `${(minor / 100).toFixed(2)} ${currency}`; }
}
const longDate = (iso) => { try { return new Intl.DateTimeFormat("en-US", { weekday: "short", year: "numeric", month: "short", day: "numeric", timeZone: "UTC" }).format(new Date(`${iso}T00:00:00Z`)); } catch { return iso; } };

/** GET /api/checkout/config -> { mode, termsVersion } | null (unavailable / unexpected). Same origin; nothing is sent. */
export async function readCheckoutConfig(fetchFn) {
  try {
    const r = await fetchFn(CONFIG_PATH, { method: "GET", credentials: "omit", cache: "no-store", referrerPolicy: "no-referrer", redirect: "error", mode: "same-origin" });
    if (r.status !== 200) return null;
    const j = await r.json();
    if (!j || typeof j !== "object" || (j.mode !== "test" && j.mode !== "live") || typeof j.termsVersion !== "string" || !/^[A-Za-z0-9._-]{1,64}$/.test(j.termsVersion)) return null;
    return { mode: j.mode, termsVersion: j.termsVersion };
  } catch { return null; }
}

export async function startApp(doc, win) {
  const $ = (id) => doc.getElementById(id);
  const show = (id, on) => { $(id).hidden = !on; };
  const realSearch = win.location.search;
  const parsed = parseStayQuery(realSearch);
  const stay = parsed && parsed.ok ? parsed.stay : null;
  const server = await readCheckoutConfig(win.fetch.bind(win));
  const termsVersion = server ? server.termsVersion : "";
  show("mv-test-banner", !!server && server.mode === "test");
  const pol = $("mv-policy-list"); pol.replaceChildren();
  for (const line of CANCELLATION_POLICY) { const li = doc.createElement("li"); li.textContent = line; pol.append(li); }
  const stayLine = stay ? `${stay.name || `Property ${stay.listingId}`} · ${longDate(stay.from)} to ${longDate(stay.to)} · ${stay.nights} night${stay.nights === 1 ? "" : "s"} · ${stay.guests} guest${stay.guests === 1 ? "" : "s"}` : "";
  let announced = null; let autoStarted = false; let ctl = null; let lastScreen = null;
  const ui = {
    render(v) {
      const c = guestCopy(v);
      const noStay = v.screen === "create" && !stay;
      $("mv-title").textContent = noStay ? "Choose your stay first" : c.title;
      $("mv-text").textContent = noStay ? (parsed && !parsed.ok ? "This booking link is not complete. Please go back to the property page and choose your dates again." : "Please choose a property and dates on our site, then use Book now.") : c.text;
      lastScreen = v.screen;
      const newStay = offerNewStay(v.screen, stay);
      $("mv-stay").textContent = stayLine; show("mv-stay", !!stay && (newStay || ["create", "details", "pay", "loading"].includes(v.screen)));
      show("mv-new", newStay);
      const n = $("mv-notice");
      n.textContent = guestNoticeFor(v.notice); n.dataset.level = v.notice ? v.notice.level : ""; n.hidden = !guestNoticeFor(v.notice);
      const codes = [...new Set([showsSupportCode(v.notice) ? v.notice.code : null, v.pollStopped].filter((x) => x != null).map(supportCode))];
      $("mv-diag").textContent = codes.length ? `Support code: ${codes.join(", ")}` : ""; $("mv-diag").hidden = !codes.length;
      const p = $("mv-price"); p.replaceChildren();
      if (v.price) {
        for (const l of v.price.lines) { const li = doc.createElement("li"); li.textContent = `${l.label}: ${formatMoney(l.amountMinor, v.price.currency)}`; p.append(li); }
        const t = doc.createElement("li"); t.className = "total"; t.textContent = `Total: ${formatMoney(v.price.totalMinor, v.price.currency)}`; p.append(t);
      }
      show("mv-create", v.screen === "create" && !!stay && !isUnbookable(v.notice)); show("mv-details", v.screen === "details"); show("mv-pay", v.screen === "pay" || (v.retry === "details" && v.canPay));
      show("mv-policy", ["create", "details", "pay"].includes(v.screen) && !noStay);
      show("mv-ack-create", v.screen === "createUncertain");
      show("mv-reset", !["create", "loading", "redirecting", "createUncertain"].includes(v.screen));
      const rb = $("mv-retry-btn"); rb.hidden = v.retry !== "details"; rb.textContent = v.retry === "details" ? "Send my details again" : "";
      $("mv-terms-label").textContent = v.termsVersion ? `I have read and accept the cancellation policy above and the booking terms (version ${v.termsVersion}).` : "Booking is not available right now.";
      $("mv-terms").disabled = !v.termsVersion;
      const latched = { "mv-details-submit": "details", "mv-pay-btn": "pay", "mv-create-submit": "create" };
      for (const b of doc.querySelectorAll("button")) {
        b.disabled = v.busy || (b.id === "mv-details-submit" && !v.termsVersion) || (latched[b.id] !== undefined && v.latch === latched[b.id]) || (b.id === "mv-pay-btn" && !v.canPay);
      }
      $("mv-refresh").hidden = !v.canRefresh && !v.busy;
      const refreshOffered = v.canRefresh || v.busy;
      $("mv-polling").textContent = v.polling ? "Checking automatically…" : v.pollStopped && !(v.notice && v.notice.level !== "info") ? stopLine(v.pollStopped, refreshOffered) : "";
      $("mv-restart").textContent = v.reset === "startNew" ? "Start a new booking…" : "Leave this booking on this device…";
      $("mv-reset-warn").textContent = v.reset === "startNew" ? "This clears this page only." : "This only clears this page. It does not cancel a booking or a payment, and this page will no longer be able to show its status.";
      const a = announcementFor({ ...v, title: c.title, notice: v.notice ? { ...v.notice, text: guestNoticeFor(v.notice) } : null }, announced);
      if (a) { announced = a.key; if (a.key !== null || $("mv-announce").textContent !== "") $("mv-announce").textContent = a.text; }
      // the guest already chose the stay on the property page: ask the server for the price once, without another click
      if (v.screen === "create" && stay && !autoStarted && !v.busy && ctl) { autoStarted = true; win.setTimeout(() => ctl.create({ from: stay.from, to: stay.to, guests: stay.guests }), 0); }
    }
  };
  // the stay link is NOT a Stripe return hint: the controller sees a query only when it is one of the two hints (and strips only that)
  const nav = { assign: (u) => win.location.assign(u), search: () => (RETURN_HINTS.includes(realSearch) ? realSearch : ""), stripQuery: () => win.history.replaceState(null, "", win.location.pathname) };
  let storage; try { storage = win.sessionStorage; } catch { storage = null; }
  const store = createStore(storage || { getItem() { throw new Error("x"); }, setItem() { throw new Error("x"); }, removeItem() { throw new Error("x"); } });
  const config = { listingId: stay ? stay.listingId : 0, currency: "USD", termsVersion };
  const c = createController({ api: createApi(win.fetch.bind(win)), store, ui, timers: { setTimeout: win.setTimeout.bind(win), clearTimeout: win.clearTimeout.bind(win) }, nav, config });
  ctl = c;
  const form = (id) => new FormData($(id));
  const details = () => { const f = form("mv-details"); return { firstName: String(f.get("firstName")), lastName: String(f.get("lastName")), email: String(f.get("email")), phone: String(f.get("phone") || ""), accepted: $("mv-terms").checked }; };
  $("mv-create").addEventListener("submit", (e) => { e.preventDefault(); if (stay) c.create({ from: stay.from, to: stay.to, guests: stay.guests }); });
  $("mv-details").addEventListener("submit", (e) => { e.preventDefault(); c.details(details()); });
  $("mv-pay-btn").addEventListener("click", () => c.pay());
  $("mv-retry-btn").addEventListener("click", () => { if (c.state.retry === "details" && typeof $("mv-details").reportValidity === "function" && !$("mv-details").reportValidity()) return; c.retryUncertain(details()); });
  $("mv-ack-create-btn").addEventListener("click", () => { if (win.confirm("An earlier request may exist. Start a new booking request anyway?")) c.acknowledgeUncertainCreate(); });
  $("mv-refresh").addEventListener("click", () => c.refresh());
  // P4-1b: clear the finished booking from this tab (nothing is sent), then ask for the new stay's price
  $("mv-new-btn").addEventListener("click", () => { if (!stay || !offerNewStay(lastScreen, stay)) return; autoStarted = true; c.startOver(); c.create({ from: stay.from, to: stay.to, guests: stay.guests }); });
  $("mv-restart").addEventListener("click", () => { if (win.confirm("Clear this booking from this page? This does not cancel a booking or a payment.")) { autoStarted = true; c.startOver(); } });
  c.init();
  return c;
}

if (typeof document !== "undefined" && document.getElementById("mv-app")) startApp(document, window).catch(() => {});
