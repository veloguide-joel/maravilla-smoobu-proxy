// scripts/mv-pipeline-wiring.mjs — P2c-3: provider wiring for scripts/mv-pipeline.mjs (deps.buildPhases).
//
// For ONE booking it builds the three phases the coordinator needs, with executors BOUND to that booking's listing, stay, reference,
// amount and (once known) reservation id, through the accepted adapters only:
//   scripts/e7-connected/real-exchange.mjs      the HTTPS exchange (fixed provider origins, no redirects, bounded bytes)
//   scripts/e7-connected/http-transports.mjs    the Hostaway / Stripe request allowlists and credential handling
//   scripts/e7-connected/executor-adapters.mjs  createPhaseExecutors: the exact executor key set per phase, bound to the booking
// Executors are late-bound exactly like the proven runner does: reservation first; capture and recording only once the reservation id is
// durable (re-bound from fresh persisted facts after every coordinator step). An unbound executor throws; it never reaches a provider.
//
// The Stripe transport is chosen by mode: TEST admits a TEST secret key only; LIVE admits a restricted live key only and requires
// livemode === true on every PaymentIntent reply. No value of any credential is ever logged, returned or stored here.
import { loadIntent } from "../lib/booking-db/repo.js";
import { validateAdapterConfig } from "../lib/hostaway-reservations.js";
import { captureKey } from "../lib/checkout/intent-state.js";
import { createPhaseExecutors } from "./e7-connected/executor-adapters.mjs";
import { createE7HostawaySend, createE7StripeTestSend, createE7StripeLiveSend } from "./e7-connected/http-transports.mjs";
import { createE7RealExchange } from "./e7-connected/real-exchange.mjs";

export const WIRING_VERSION = "mv-pipeline-wiring-v1";
export const STRIPE_API_VERSION = "2026-01-28.clover";            // the version the proven runner pins
export const CHANNEL_ID = 2000;
export const PAYMENT_METHOD = "credit_card";

const { freeze } = Object;
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
export class WiringRefusal extends Error { constructor(code) { super("WIRING_REFUSED"); this.name = "WiringRefusal"; this.code = code; } }
const refuse = (code) => { throw new WiringRefusal(code); };

const TEST_KEY_RE = /^sk_test_[A-Za-z0-9]{1,247}$/;
const LIVE_KEY_RE = /^rk_live_[A-Za-z0-9]{8,200}$/;
const ACCT_RE = /^acct_[A-Za-z0-9]{1,64}$/;
const LABEL_RE = /^[A-Za-z0-9._:-]{1,80}$/;

/** Static checks, before anything is built. The Stripe key's kind must match the mode; values are never echoed. */
export function validateWiringOptions(o) {
  if (!isObj(o)) refuse("OPTIONS_INVALID");
  if (o.mode !== "test" && o.mode !== "live") refuse("MODE_INVALID");
  if (typeof o.stripeKey !== "string" || typeof o.hostawayToken !== "string" || !o.hostawayToken || o.hostawayToken.length > 4096) refuse("CREDENTIAL_INVALID");
  const isTestKey = TEST_KEY_RE.test(o.stripeKey); const isLiveKey = LIVE_KEY_RE.test(o.stripeKey);
  if (!isTestKey && !isLiveKey) refuse("CREDENTIAL_INVALID");
  if ((o.mode === "test") !== isTestKey) refuse("KEY_MODE_MISMATCH");
  if (typeof o.stripeAccountId !== "string" || !ACCT_RE.test(o.stripeAccountId)) refuse("ACCOUNT_ID_INVALID");
  if (!Number.isSafeInteger(o.refFieldId) || o.refFieldId <= 0) refuse("REF_FIELD_INVALID");
  if (typeof o.timeZone !== "string" || !/^[A-Za-z_]+\/[A-Za-z_]+$/.test(o.timeZone)) refuse("TIME_ZONE_INVALID");
  if (typeof o.accountRef !== "string" || !LABEL_RE.test(o.accountRef) || typeof o.runId !== "string" || !LABEL_RE.test(o.runId)) refuse("LABEL_INVALID");
  if (!o.pool || typeof o.pool.query !== "function") refuse("POOL_REQUIRED");
  return true;
}

const GUEST_SQL = "SELECT g.first_name, g.last_name, g.email FROM booking.intent_guests g WHERE g.intent_id = $1";
const CREATE_SQL = "SELECT state, result_ref FROM booking.external_operations WHERE intent_id = $1 AND op_type = 'hostaway.create_reservation' ORDER BY created_at, id";

/**
 * createWiring({ mode, pool, stripeKey, hostawayToken, stripeAccountId, refFieldId, timeZone, accountRef, runId, exchanges? })
 *   -> { buildPhases(intentRef, cfg) -> { phases, env, clock, recordingClock, hooks } }
 * exchanges ({ stripe, hostaway }: request -> reply) is injectable for tests; by default the accepted real HTTPS exchange.
 */
export function createWiring(o) {
  validateWiringOptions(o);
  const { pool, stripeAccountId, refFieldId, timeZone, accountRef, runId } = o;
  const xs = o.exchanges ? { ok: true, exchange: o.exchanges.stripe } : createE7RealExchange({ provider: "stripe" });
  const xh = o.exchanges ? { ok: true, exchange: o.exchanges.hostaway } : createE7RealExchange({ provider: "hostaway" });
  if (!xs || xs.ok !== true || !xh || xh.ok !== true) refuse("EXCHANGE_INVALID");
  const sk = o.stripeKey; const ht = o.hostawayToken;
  const ts = (o.mode === "live" ? createE7StripeLiveSend : createE7StripeTestSend)({ exchange: xs.exchange, credential: () => sk, accountId: stripeAccountId, apiVersion: STRIPE_API_VERSION });
  const th = createE7HostawaySend({ exchange: xh.exchange, credential: () => ht });
  if (!ts || ts.ok !== true || !th || th.ok !== true) refuse("TRANSPORT_INVALID");
  const hostawaySend = (req, opts) => th.transport.send(req, opts);
  const stripeSend = (call, opts) => ts.transport.send(call, opts);
  const LABEL = freeze({ accountRef, clientSnapshotId: runId });

  async function buildPhases(intentRef, cfg) {
    const id = intentRef.id; const listingId = intentRef.listingId;
    const lc = cfg.listings.get(listingId);
    if (!lc) refuse("LISTING_NOT_CONFIGURED");
    const first = await loadIntent(pool, id);
    if (!first || first.ref !== intentRef.ref || first.listingId !== listingId || !first.price || !first.payment) refuse("INTENT_NOT_BOUND");
    if (first.price.currency !== lc.currency) refuse("CURRENCY_MISMATCH");
    const g = (await pool.query(GUEST_SQL, [id])).rows;
    if (g.length !== 1 || typeof g[0].email !== "string" || typeof g[0].first_name !== "string" || typeof g[0].last_name !== "string") refuse("GUEST_NOT_FOUND");
    const guest = freeze({ email: g[0].email, firstName: g[0].first_name, lastName: g[0].last_name });
    const total = first.price.finalTotalMinor; const pi = first.payment.paymentIntentId;
    const common = { listingId, arrivalDate: first.from, departureDate: first.to, ref: first.ref };
    const bound = { res: null, resId: undefined, cap: null, rec: null, rid: null };
    const must = (bx) => { if (!bx || bx.ok !== true) refuse(`EXECUTOR_BINDING_REFUSED`); return bx.executors; };
    const bindReservation = (rid) => {
      bound.res = must(createPhaseExecutors({ phase: rid === null ? "reservation" : "reservation-recovery",
        binding: { ...common, guests: first.guests, totalMinor: total, currency: lc.currency, refFieldId, guest, reservationId: rid }, hostaway: { send: hostawaySend } }));
      bound.resId = rid;
    };
    const bindAfterReservation = (rid) => {
      bound.cap = must(createPhaseExecutors({ phase: "capture", binding: { ...common, reservationId: rid, accountId: stripeAccountId, paymentIntentId: pi, amountMinor: total,
        captureIdempotencyKey: captureKey(id, pi, 1) }, hostaway: { send: hostawaySend }, stripe: { send: stripeSend } }));
      bound.rec = must(createPhaseExecutors({ phase: "recording", binding: { listingId, reservationId: rid, intentId: id, amountMinor: total, paymentMethod: PAYMENT_METHOD,
        accountRef, clientSnapshotId: runId }, hostaway: { send: hostawaySend } }));
      bound.rid = rid;
    };
    /** bind from FRESH persisted facts: the adopted reservation id, else the one succeeded create's id, else none */
    const rebind = async () => {
      const i = await loadIntent(pool, id);
      const creates = (await pool.query(CREATE_SQL, [id])).rows;
      if (creates.length > 1) refuse("FACTS_INCONSISTENT");
      const adopted = i.reservation ? String(i.reservation.reservationId) : null;
      const created = creates.length === 1 && creates[0].state === "succeeded" && creates[0].result_ref ? String(creates[0].result_ref) : null;
      if (adopted && created && adopted !== created) refuse("FACTS_INCONSISTENT");
      const rid = adopted ?? created;
      if (bound.res === null || bound.resId !== rid) bindReservation(rid);
      if (adopted && bound.rid !== adopted) bindAfterReservation(adopted);          // capture / recording only for a VERIFIED (adopted) reservation
    };
    const via = (slot, key, sub = null) => async (...a) => {
      const ex = bound[slot]; const fn = ex ? (sub ? ex[key] && ex[key][sub] : ex[key]) : null;
      if (typeof fn !== "function") { const e = new Error("executor unbound"); e.code = "EXECUTOR_UNBOUND"; throw e; }
      return Reflect.apply(fn, sub ? ex[key] : undefined, a);
    };
    const proxies = {
      reservation: freeze({ pricing: freeze({ get: via("res", "pricing", "get"), post: via("res", "pricing", "post") }), lookupPage: via("res", "lookupPage"),
        retrieveReservation: via("res", "retrieveReservation"), createReservation: via("res", "createReservation") }),
      capture: freeze({ retrieveAccount: via("cap", "retrieveAccount"), retrievePaymentIntent: via("cap", "retrievePaymentIntent"),
        capturePaymentIntent: via("cap", "capturePaymentIntent"), retrieveReservation: via("cap", "retrieveReservation"), lookupPage: via("cap", "lookupPage") }),
      recording: freeze({ label: LABEL, retrieveReservation: via("rec", "retrieveReservation"), listOfflineCharges: via("rec", "listOfflineCharges"),
        createOfflineCharge: via("rec", "createOfflineCharge") })
    };
    await rebind();
    const adapterConfig = validateAdapterConfig({ allowedListingIds: [listingId], refFieldId, channelId: CHANNEL_ID, currency: lc.currency });
    const listings = new Map([[listingId, { currency: lc.currency, timeZone }]]);
    const recCfg = freeze({ accountRef, channelId: CHANNEL_ID, currency: lc.currency, listingId, paymentMethod: PAYMENT_METHOD, refFieldId });
    const env = freeze({ VERCEL_ENV: "development", MV_E7_TEST_PIPELINE_COORDINATOR: "enabled", MV_E7_RESERVATION_WORKER: "enabled", MV_E7_CAPTURE_WORKER: "enabled",
      MV_E7_RECORDING_WORKER: "enabled", DIRECT_DISCOUNT_BPS: String(first.price.rateBps) });
    return { env, clock: Date.now, recordingClock: Date.now, hooks: { afterStep: rebind },
      phases: { reservation: { adapterConfig, listings, executors: proxies.reservation },
        capture: { adapterConfig, listings, executors: proxies.capture, stripeAccountId },
        recording: { listings: new Map([[listingId, recCfg]]), executors: proxies.recording } } };
  }
  return freeze({ buildPhases });
}
