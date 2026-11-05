// public/checkout-test.js — maraVilla direct-booking TEST checkout page (Stripe TEST mode only; NO reservation is created).
// Plain ES module, no dependency, no third-party resource. Talks ONLY to the same-origin intent API:
//   POST /api/checkout/intents            create (server prices the stay; returns a one-time bearer token)
//   POST /api/checkout/intent-step        {step:"details"|"pay"|"release"|"status"} with Authorization: Bearer <token>
// Rules: the token travels only in the Authorization header and is kept per tab in sessionStorage (with the minimum resume state);
// never in a URL, console, analytics or localStorage; no guest details are stored. One explicit click per write; an uncertain write
// is never retried. Automatic status reads are bounded (<= 24 per 10 minutes per tab + token, one request at a time) and stop on 429.
// Server strings are rendered as text only. The Stripe return query (?checkout=complete|cancelled) is a display hint, never evidence.

export const STORE_KEY = "mv-checkout-test-v1";
export const API = Object.freeze({ intents: "/api/checkout/intents", step: "/api/checkout/intent-step" });
export const POLL = Object.freeze({ windowMs: 10 * 60 * 1000, maxAuto: 24, intervalMs: 5000 });
export const REQUEST_TIMEOUT_MS = 15000;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const STATUS_RE = /^[a-z_]{1,40}$/;
const CODE_RE = /^[A-Z0-9_]{1,64}$/;

// ---------------------------------------------------------------------------------------------------------------------------------
// pure helpers

/** The pay step's redirect target: only an https URL on checkout.stripe.com (no credentials, no port). Else null. */
export function validateCheckoutUrl(u) {
  if (typeof u !== "string" || u.length > 2048) return null;
  let x; try { x = new URL(u); } catch { return null; }
  if (x.protocol !== "https:" || x.hostname !== "checkout.stripe.com" || x.port !== "" || x.username !== "" || x.password !== "") return null;
  return x.href;
}
const safeStatus = (s) => (typeof s === "string" && STATUS_RE.test(s) ? s : null);
const safeCode = (c) => (typeof c === "string" && CODE_RE.test(c) ? c : "UNEXPECTED_REPLY");

/** Guest-facing description of a server status. `released` = this tab asked for a release earlier. Never "booking confirmed". */
export function describe(status, { releaseRequested = false } = {}) {
  switch (status) {
    case "awaiting_details": return { kind: "details", title: "Enter guest details", text: "The price shown is set by the server. Nothing is held yet." };
    case "awaiting_payment": return { kind: "pay", title: "Ready for TEST payment", text: "Continue to Stripe's hosted TEST Checkout. If you already paid, the server has not confirmed the authorization yet." };
    case "processing": return { kind: "authorized", title: "TEST authorization held — not a booking",
      text: "Stripe TEST mode reports a card authorization (a hold, not a charge). No reservation is created by this page and nothing is confirmed. Request the release when you are done." };
    case "release_requested": return { kind: "releaseQueued", title: "Release requested — not released yet",
      text: "The release request is recorded and a void is queued. The TEST hold stays until the separate cleanup worker (run by the owner) verifies the release." };
    case "unavailable_not_charged": return releaseRequested
      ? { kind: "released", title: "Release verified — not charged", text: "The server reports the TEST authorization released. A bank may still show a temporary hold for a while." }
      : { kind: "terminal", title: "Not charged", text: "The server reports this TEST intent closed without a charge." };
    case "under_review": return { kind: "review", title: "Owner review required",
      text: "The server could not prove the outcome (for example the release could not be verified). The TEST hold may still exist. Nothing more is sent from this page." };
    case "expired": return { kind: "terminal", title: "Expired", text: "This TEST intent or its Checkout session expired. No charge was made. You may start a new TEST booking." };
    case "payment_failed": return { kind: "terminal", title: "Payment failed", text: "Stripe did not authorize the TEST payment. You may start a new TEST booking." };
    case "unavailable": return { kind: "terminal", title: "Not available", text: "The server could not price or hold these dates." };
    case "not_completed_not_charged": return { kind: "terminal", title: "Not completed — not charged", text: "The server reports this TEST intent closed without a charge." };
    case "confirmed": return { kind: "unexpected", title: "Unexpected server status",
      text: "The server reports 'confirmed', which this TEST page never expects (it creates no reservation). Do not treat this as a booking. Contact the owner." };
    default: return { kind: "unexpected", title: "Unknown status", text: "The server returned a status this page does not know. Nothing more is sent automatically." };
  }
}
const POLL_KINDS = new Set(["pay", "releaseQueued"]);    // states worth re-reading automatically (after Stripe return / after a release request)

/** sessionStorage wrapper. Every access is guarded; `ok` is false when the browser refuses storage. Stores no guest data. */
export function createStore(storage) {
  const guard = (fn, dflt) => { try { return fn(); } catch { return dflt; } };
  return {
    load() {
      const raw = guard(() => storage.getItem(STORE_KEY), null);
      if (typeof raw !== "string") return null;
      const v = guard(() => JSON.parse(raw), null);
      if (!v || typeof v !== "object" || !TOKEN_RE.test(v.token || "")) return null;
      return { token: v.token, releaseRequested: v.releaseRequested === true, polls: Array.isArray(v.polls) ? v.polls.filter(Number.isFinite).slice(-POLL.maxAuto) : [] };
    },
    save(s) {
      const v = JSON.stringify({ token: s.token, releaseRequested: s.releaseRequested === true, polls: (s.polls || []).slice(-POLL.maxAuto) });
      return guard(() => { storage.setItem(STORE_KEY, v); return storage.getItem(STORE_KEY) === v; }, false);
    },
    clear() { return guard(() => { storage.removeItem(STORE_KEY); return true; }, false); }
  };
}

/** Same-origin JSON API. -> { kind:"reply", http, body } | { kind:"unknown" } (network / timeout / unreadable reply). */
export function createApi(fetchFn, { timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  async function post(path, body, token) {
    const headers = { "Content-Type": "application/json" };
    if (token) headers.Authorization = `Bearer ${token}`;
    let res;
    try {
      res = await fetchFn(path, { method: "POST", headers, body: JSON.stringify(body), credentials: "omit", cache: "no-store", referrerPolicy: "no-referrer",
        redirect: "error", mode: "same-origin", signal: AbortSignal.timeout(timeoutMs) });
    } catch { return { kind: "unknown" }; }
    let json = null;
    try { json = await res.json(); } catch { json = null; }
    if (!Number.isInteger(res.status) || json === null || typeof json !== "object") return { kind: "unknown", http: res.status };
    return { kind: "reply", http: res.status, body: json };
  }
  return {
    create: (stay) => post(API.intents, stay, null),
    details: (token, d) => post(API.step, { step: "details", ...d }, token),
    pay: (token) => post(API.step, { step: "pay" }, token),
    release: (token) => post(API.step, { step: "release" }, token),
    status: (token) => post(API.step, { step: "status" }, token)
  };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// controller (DOM-free; the page binds it to elements below)

/**
 * createController({ api, store, ui, timers, nav, config, now })
 *   ui.render(view)   view = { screen, title, text, price?, notice?, polling, busy, canRefresh, actions:{...} }
 *   timers: { setTimeout, clearTimeout }   nav: { assign(url), search(), stripQuery() }   config: { listingId, currency, termsVersion }
 */
export function createController({ api, store, ui, timers, nav, config, now = () => Date.now() }) {
  let st = store.load();                // { token, releaseRequested, polls } | null
  let busy = false; let pollTimer = null; let stopped = null; let last = null; let notice = null; let price = null; let returned = false;
  const storageOk = () => (st ? store.save(st) : true);

  function view(extra = {}) {
    const d = last ? describe(last, { releaseRequested: st && st.releaseRequested }) : null;
    ui.render({ screen: st ? (d ? d.kind : "loading") : "create", title: d ? d.title : st ? "Checking status…" : "Start a TEST booking",
      text: d ? d.text : "", price, notice, busy, polling: pollTimer !== null, pollStopped: stopped, canRefresh: !!st && !busy,
      termsVersion: config.termsVersion || null, listingId: config.listingId, currency: config.currency, ...extra });
  }
  const setNotice = (n) => { notice = n; };
  async function once(fn) {                     // concurrency cap 1; buttons are disabled while busy
    if (busy) return null;
    busy = true; view();
    try { return await fn(); } finally { busy = false; }
  }
  function priceFrom(p) {
    if (!p || typeof p !== "object" || !Number.isSafeInteger(p.totalMinor) || typeof p.currency !== "string") return null;
    const lines = Array.isArray(p.lines) ? p.lines.slice(0, 20).filter((l) => l && typeof l.label === "string" && Number.isSafeInteger(l.amountMinor))
      .map((l) => ({ label: l.label.slice(0, 120), amountMinor: l.amountMinor })) : [];
    return { currency: p.currency.slice(0, 3), totalMinor: p.totalMinor, lines };
  }
  function absorb(r) {                          // a status-bearing reply
    const s = safeStatus(r.body && r.body.status);
    if (s) last = s;
    const p = priceFrom(r.body && r.body.price);
    if (p) price = p;
  }
  function stopPolling(reason) { if (pollTimer !== null) timers.clearTimeout(pollTimer); pollTimer = null; stopped = reason; }
  function autoBudgetLeft() {
    if (!st) return 0;
    const t = now(); st.polls = st.polls.filter((x) => t - x < POLL.windowMs);
    return POLL.maxAuto - st.polls.length;
  }
  function schedule() {
    if (pollTimer !== null || !st || !last) return;
    const kind = describe(last, st).kind;
    // waiting for the authorization is worth re-reading only after a return from Stripe; a queued release always is
    if (!POLL_KINDS.has(kind) || (kind === "pay" && !returned)) { stopped = null; return; }
    if (autoBudgetLeft() <= 0) { stopped = "BUDGET"; return; }
    pollTimer = timers.setTimeout(async () => { pollTimer = null; await readStatus({ auto: true }); }, POLL.intervalMs);
  }
  /** one status read; `auto` reads consume the persisted per-tab budget (and are skipped if storage cannot persist it) */
  async function readStatus({ auto = false } = {}) {
    if (!st) return;
    if (auto) {
      if (autoBudgetLeft() <= 0) { stopped = "BUDGET"; view(); return; }
      st.polls.push(now());
      if (!store.save(st)) { st.polls.pop(); stopped = "STORAGE"; view(); return; }   // a budget that cannot persist is never used
    }
    const r = await once(() => api.status(st.token));
    if (r === null) return;
    if (r.kind === "unknown") { stopPolling("UNREADABLE"); setNotice({ level: "warn", code: "STATUS_UNREADABLE", text: "The server's status could not be read. Use Refresh status." }); view(); return; }
    if (r.http === 429) { stopPolling("RATE_LIMITED"); setNotice({ level: "warn", code: "RATE_LIMITED", text: "Too many requests. Automatic status checks stopped; wait, then use Refresh status." }); view(); return; }
    if (r.http === 401) { stopPolling("UNAUTHORIZED"); setNotice({ level: "error", code: "UNAUTHORIZED", text: "This tab's TEST booking is no longer accepted by the server. Start over to try again." }); last = null; view({ screen: "lost" }); return; }
    if (r.http !== 200) { stopPolling("ERROR"); setNotice({ level: "warn", code: safeCode(r.body.code), text: "The status check failed. Use Refresh status." }); view(); return; }
    absorb(r); stopped = null; view(); schedule(); view();
  }

  return {
    get state() { return { st, last, busy, polling: pollTimer !== null, stopped, notice }; },
    /** page load / Stripe return: show the hint as text only, strip the query, read status once if this tab has a token */
    async init() {
      const q = nav.search();
      const hint = q === "?checkout=complete" ? "complete" : q === "?checkout=cancelled" ? "cancelled" : null;
      if (q) nav.stripQuery();
      returned = hint !== null;
      if (hint) setNotice({ level: "info", code: hint === "complete" ? "RETURNED_COMPLETE" : "RETURNED_CANCELLED",
        text: hint === "complete" ? "You returned from Stripe. This is only a hint: the page now asks the server what actually happened." : "You left Stripe Checkout without paying (hint only). Checking the server…" });
      if (!st) { view(); return; }
      view();
      await readStatus({ auto: true });
    },
    async create({ from, to, guests }) {
      if (st) return;                              // never a second intent while this tab holds one
      const r = await once(() => api.create({ listingId: config.listingId, from, to, guests }));
      if (r === null) return;
      if (r.kind === "unknown") { setNotice({ level: "error", code: "CREATE_UNKNOWN", text: "It is unknown whether a TEST intent was created. Nothing is retried. Start over only if you accept a possible second TEST intent." }); view(); return; }
      if (r.http !== 201 || !TOKEN_RE.test(r.body.token || "")) { setNotice({ level: "warn", code: safeCode(r.body.code), text: "The server refused the request." }); view(); return; }
      st = { token: r.body.token, releaseRequested: false, polls: [] };
      absorb(r);
      if (!store.save(st)) setNotice({ level: "error", code: "STORAGE_UNAVAILABLE", text: "This tab cannot remember the TEST booking, so returning from Stripe could not resume it. Payment is disabled in this tab." });
      else setNotice(null);
      view();
    },
    async details({ firstName, lastName, email, phone, accepted }) {
      if (!st) return;
      if (!config.termsVersion) { setNotice({ level: "error", code: "TERMS_NOT_CONFIGURED", text: "This TEST page has no terms version configured; details cannot be sent." }); view(); return; }
      if (accepted !== true) { setNotice({ level: "warn", code: "TERMS_NOT_ACCEPTED", text: "Accept the TEST terms first." }); view(); return; }
      const d = { firstName, lastName, email, termsVersion: config.termsVersion, ...(phone ? { phone } : {}) };
      const r = await once(() => api.details(st.token, d));
      if (r === null) return;
      if (r.kind === "unknown") { setNotice({ level: "warn", code: "DETAILS_UNKNOWN", text: "It is unknown whether the details were saved. Use Refresh status; nothing is resent automatically." }); view(); return; }
      if (r.http !== 200) { setNotice({ level: "warn", code: safeCode(r.body.code), text: "The server refused the details." }); view(); return; }
      absorb(r); setNotice(null); view();
    },
    async pay() {
      if (!st) return;
      if (!storageOk()) { setNotice({ level: "error", code: "STORAGE_UNAVAILABLE", text: "This tab cannot remember the TEST booking; payment stays disabled." }); view(); return; }
      const r = await once(() => api.pay(st.token));
      if (r === null) return;
      if (r.kind === "unknown") { setNotice({ level: "warn", code: "PAY_UNKNOWN", text: "It is unknown whether a Checkout session was prepared. Use Refresh status; nothing is resent automatically." }); view(); return; }
      if (r.http !== 200) { setNotice({ level: "warn", code: safeCode(r.body.code), text: "The server refused to start payment." }); view(); return; }
      const url = validateCheckoutUrl(r.body.checkoutUrl);
      if (!url) { setNotice({ level: "error", code: "CHECKOUT_URL_REFUSED", text: "The returned payment address is not Stripe's hosted Checkout; this page will not open it." }); view(); return; }
      absorb(r); view({ screen: "redirecting" });
      nav.assign(url);
    },
    async release() {
      if (!st) return;
      const r = await once(() => api.release(st.token));
      if (r === null) return;
      if (r.kind === "unknown") { setNotice({ level: "warn", code: "RELEASE_UNKNOWN", text: "It is unknown whether the release request was recorded. Use Refresh status; nothing is resent automatically." }); view(); return; }
      if (r.http === 404 || (r.http === 400 && r.body.code === "UNKNOWN_STEP")) { setNotice({ level: "warn", code: "RELEASE_NOT_ENABLED", text: "Release requests are not enabled on this deployment." }); view(); return; }
      if (r.http !== 202) { setNotice({ level: "warn", code: safeCode(r.body.code), text: "The server refused the release request." }); view(); return; }
      st.releaseRequested = true; store.save(st);
      absorb(r); setNotice({ level: "info", code: "RELEASE_REQUESTED", text: "Release requested. It is queued, not done." }); view(); schedule(); view();
    },
    async refresh() { stopPolling(null); setNotice(null); await readStatus({ auto: false }); },
    startOver() { stopPolling(null); store.clear(); st = null; last = null; price = null; setNotice(null); view(); }
  };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// DOM binding (only when loaded by checkout-test.html)

function formatMoney(minor, currency) {
  try { return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(minor / 100); } catch { return `${(minor / 100).toFixed(2)} ${currency}`; }
}
export function startApp(doc, win) {
  const $ = (id) => doc.getElementById(id);
  const root = $("mv-test-app");
  const config = { listingId: Number(root.dataset.listingId), currency: root.dataset.currency, termsVersion: (doc.querySelector('meta[name="mv-test-terms-version"]') || {}).content || "" };
  const show = (id, on) => { $(id).hidden = !on; };
  const ui = {
    render(v) {
      $("mv-title").textContent = v.title; $("mv-text").textContent = v.text;
      $("mv-listing").textContent = `Listing ${v.listingId} (${v.currency})`;
      const n = $("mv-notice");
      n.textContent = v.notice ? `${v.notice.text} [${v.notice.code}]` : ""; n.dataset.level = v.notice ? v.notice.level : ""; n.hidden = !v.notice;
      const p = $("mv-price"); p.replaceChildren();
      if (v.price) {
        for (const l of v.price.lines) { const li = doc.createElement("li"); li.textContent = `${l.label}: ${formatMoney(l.amountMinor, v.price.currency)}`; p.append(li); }
        const t = doc.createElement("li"); t.className = "total"; t.textContent = `Total (server price, TEST): ${formatMoney(v.price.totalMinor, v.price.currency)}`; p.append(t);
      }
      show("mv-create", v.screen === "create"); show("mv-details", v.screen === "details"); show("mv-pay", v.screen === "pay");
      show("mv-release", v.screen === "authorized"); show("mv-restart", !["create", "loading", "redirecting"].includes(v.screen));
      $("mv-terms-label").textContent = v.termsVersion ? `I accept the TEST terms, version ${v.termsVersion}.` : "TEST page not configured: no terms version.";
      $("mv-terms").disabled = !v.termsVersion;
      for (const b of doc.querySelectorAll("button")) b.disabled = v.busy || (b.id === "mv-details-submit" && !v.termsVersion);
      $("mv-refresh").hidden = !v.canRefresh && !v.busy;
      $("mv-polling").textContent = v.polling ? "Checking the server automatically…" : v.pollStopped ? `Automatic checks stopped (${v.pollStopped}). Use Refresh status.` : "";
    }
  };
  const nav = { assign: (u) => win.location.assign(u), search: () => win.location.search, stripQuery: () => win.history.replaceState(null, "", win.location.pathname) };
  let storage; try { storage = win.sessionStorage; } catch { storage = null; }
  const store = createStore(storage || { getItem() { throw new Error("x"); }, setItem() { throw new Error("x"); }, removeItem() { throw new Error("x"); } });
  const c = createController({ api: createApi(win.fetch.bind(win)), store, ui, timers: { setTimeout: win.setTimeout.bind(win), clearTimeout: win.clearTimeout.bind(win) }, nav, config });
  const form = (id) => new FormData($(id));
  $("mv-create").addEventListener("submit", (e) => { e.preventDefault(); const f = form("mv-create"); c.create({ from: String(f.get("from")), to: String(f.get("to")), guests: Number(f.get("guests")) }); });
  $("mv-details").addEventListener("submit", (e) => { e.preventDefault(); const f = form("mv-details");
    c.details({ firstName: String(f.get("firstName")), lastName: String(f.get("lastName")), email: String(f.get("email")), phone: String(f.get("phone") || ""), accepted: $("mv-terms").checked }); });
  $("mv-pay-btn").addEventListener("click", () => c.pay());
  $("mv-release-btn").addEventListener("click", () => c.release());
  $("mv-refresh").addEventListener("click", () => c.refresh());
  $("mv-restart").addEventListener("click", () => { if (win.confirm("Forget this TEST booking in this tab? Nothing is cancelled or released by this.")) c.startOver(); });
  c.init();
  return c;
}

if (typeof document !== "undefined" && document.getElementById("mv-test-app")) startApp(document, window);
