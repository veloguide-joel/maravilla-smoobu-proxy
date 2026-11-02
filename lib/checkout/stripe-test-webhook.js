// lib/checkout/stripe-test-webhook.js — Stage E5a (offline implementation; Stripe TEST mode only).
//
// Two entry points, both called only AFTER stripeTestGate() passed, both with an INJECTED Stripe client:
//
//   startTestCheckout(pool, intentId, deps)       one Checkout Session create for the outbox row queued by beginPayStep
//   processVerifiedStripeEvent(pool, event, deps) a webhook event whose signature was ALREADY verified on the raw body
//
// No Hostaway call exists here, and no capture, void or refund: E3 effects stay rows in the outbox (EXTERNAL dispatch
// remains disabled; only the one injected Checkout-create executor is ever run, and only by startTestCheckout).
//
// Webhook bookkeeping (Stripe delivers at least once, unordered, possibly concurrently):
//   - recordStripeEvent de-duplicates permanently by event id; finished events are never processed again.
//   - The authorization path applies E3 PAYMENT_AUTHORIZED and marks the event processed in ONE transaction (applyEvent
//     inTx). A duplicate (same event id already applied, or the same PaymentIntent already accepted under another event
//     id) commits nothing new; the event is then finished on its own. A crash before that finish leaves it 'received',
//     and the redelivery takes the same duplicate path: nothing is stranded or applied twice.
//   - Anything not resolved (ordering not ready, Stripe read failed, binding not exact, unexpected state) is recorded as
//     failed_retryable and answered 503 so Stripe redelivers. It is never acknowledged as done.
//   - Every provider fact enters through a queued, succeeded READ operation and persisted evidence (E2B.1 trust trail).
import { randomUUID } from "node:crypto";
import { applyEvent, beginPayStep, recordCheckoutSession, applyCheckoutSessionEvidence, loadIntent } from "../../db/lib/repo.js";
import { claimNextOperation, completeOperation, dispatchOperation, requestRead, recordProviderEvidence, findCheckoutCreateForAttempt } from "../../db/lib/operations.js";
import { recordStripeEvent, finishStripeEvent, markStripeEventProcessedInTx, findAttemptBySession, findAttemptById } from "../../db/lib/webhooks.js";
import { assertEnvironment } from "../../db/lib/pool.js";
import {
  stripeTestGate, createCheckoutSessionExecutor, bindAuthorization, sessionObservation, paymentIntentObservation,
  isTestSessionId, isPaymentIntentId, isUuid, CHECKOUT_CREATE_OP
} from "./stripe-test-mode.js";

const EVT_RE = /^evt_[A-Za-z0-9_]{1,200}$/;
const TYPE_RE = /^[a-z_.]{1,100}$/;
const CODE_RE = /^[A-Z0-9_]{1,64}$/;
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/** Stripe event types this slice reads. Everything else is recorded and ignored. */
export const EVENT_KINDS = Object.freeze({
  "checkout.session.completed": "authorization",
  "checkout.session.expired": "expiry",
  // a declined card inside an OPEN Checkout Session is not terminal (the guest may retry); expiry decides
  "payment_intent.payment_failed": "informational",
  // card-only sessions never produce these; if one arrives, something is not as configured: left unresolved
  "checkout.session.async_payment_succeeded": "unexpected",
  "checkout.session.async_payment_failed": "unexpected"
});

class Coded extends Error {
  constructor(code) { super(code); this.code = code; }
}
const coded = (c) => new Coded(CODE_RE.test(String(c)) ? String(c) : "INTERNAL_ERROR");
export const safeCode = (e) => (e && CODE_RE.test(String(e.code || "")) ? String(e.code) : "INTERNAL_ERROR");
const reply = (http, code, extra = {}) => ({ http, code, ...extra });

/** The configured TEST account must be the account the key belongs to (GET /v1/account, read-only, cached on success). */
export async function verifyAccount(stripe, accountId, cache) {
  if (cache && cache.verifiedFor === accountId) return true;
  let a;
  try { a = await stripe.accounts.retrieve(); } catch { throw coded("ACCOUNT_READ_FAILED"); }
  if (!isObj(a) || a.object !== "account" || a.id !== accountId) throw coded("ACCOUNT_MISMATCH");
  if (cache) cache.verifiedFor = accountId;
  return true;
}

/** Queue one read, claim exactly it, run it through the injected client, record the result as evidence. */
async function verifiedRead(pool, intentId, { opType, kind, ref, fetch, observe, now, workerId }) {
  const opId = await requestRead(pool, intentId, opType, ref, { now });
  const op = await claimNextOperation(pool, { workerId, now, opId });
  if (!op) throw coded("READ_NOT_CLAIMABLE");
  let obj;
  try { obj = await fetch(); } catch {
    await completeOperation(pool, op.id, { workerId, now, outcome: { status: "failed_definite", errorCode: "STRIPE_READ_FAILED" } });
    throw coded("STRIPE_READ_FAILED");
  }
  if (!isObj(obj) || obj.id !== ref) {
    await completeOperation(pool, op.id, { workerId, now, outcome: { status: "failed_definite", errorCode: "READ_OBJECT_MISMATCH" } });
    throw coded("READ_OBJECT_MISMATCH");
  }
  const done = await completeOperation(pool, op.id, { workerId, now, outcome: { status: "succeeded", resultRef: ref } });
  if (!done.ok) throw coded(done.error);
  const ev = await recordProviderEvidence(pool, { readOpId: op.id, kind, externalRef: ref, status: String(obj.status), observed: observe(obj) });
  if (!ev.ok) throw coded(ev.error);
  return { obj, evidenceId: ev.id };
}

/** Resolve the payment attempt a session event refers to, or explain why it cannot be resolved yet. */
async function attemptFor(pool, obj) {
  if (!isObj(obj) || obj.object !== "checkout.session" || !isTestSessionId(obj.id)) return { code: "PAYLOAD_NOT_A_TEST_SESSION" };
  const a = await findAttemptBySession(pool, obj.id);
  if (a) return { attempt: a };
  const md = isObj(obj.metadata) ? obj.metadata : {};
  if (!isUuid(md.mv_payment_attempt_id)) return { foreign: true };
  const b = await findAttemptById(pool, md.mv_payment_attempt_id);
  // Stripe can deliver before our own write of the session id commits: a retry will find it
  if (b && ["creating", "outcome_unknown"].includes(b.status) && !b.checkout_session_id) return { code: "SESSION_NOT_YET_RECORDED" };
  return { code: "SESSION_NOT_BOUND" };
}

/**
 * processVerifiedStripeEvent(pool, event, { stripe, now, workerId?, accountId, accountCache?, config?, hooks? })
 *   -> { http, code, state? }   http 200 = recorded and finished; 400 = refused (not stored); 503 = unresolved, redeliver
 * `event` MUST come from Stripe's signature verification of the raw body. hooks exist for crash/concurrency tests only.
 */
export async function processVerifiedStripeEvent(pool, event, deps) {
  const { stripe, now, accountId, accountCache = null, config = {}, hooks = {} } = deps;
  const workerId = deps.workerId || `wh-${randomUUID().slice(0, 8)}`;
  if (!Number.isFinite(now)) throw new TypeError("now required");
  if (!isObj(event) || event.object !== "event" || !EVT_RE.test(String(event.id)) || !TYPE_RE.test(String(event.type))
      || !isObj(event.data) || !isObj(event.data.object) || !Number.isSafeInteger(event.created)) return reply(400, "EVENT_MALFORMED");
  if (event.livemode !== false) return reply(400, "LIVEMODE_REFUSED");
  if (event.account != null) return reply(400, "CONNECT_EVENT_REFUSED");
  const obj = event.data.object;
  const objectId = typeof obj.id === "string" && /^[a-z]{2,6}_[A-Za-z0-9_]{1,200}$/.test(obj.id) ? obj.id : null;

  const rec = await recordStripeEvent(pool, { eventId: event.id, type: event.type, livemode: false,
    apiVersion: typeof event.api_version === "string" ? event.api_version.slice(0, 40) : null, createdAt: event.created * 1000, objectId }, { now });
  if (rec.status === "refused") return reply(400, rec.error || "REFUSED");
  if (!rec.shouldProcess) return reply(200, `ALREADY_${String(rec.status).toUpperCase()}`);

  const finish = (status, extra = {}) => finishStripeEvent(pool, event.id, { status, now, ...extra });
  const kind = EVENT_KINDS[event.type];
  if (!kind) { await finish("ignored", { errorCode: "TYPE_NOT_HANDLED" }); return reply(200, "IGNORED_TYPE"); }
  if (kind === "informational") { await finish("ignored", { errorCode: "NOT_TERMINAL_SESSION_OPEN" }); return reply(200, "IGNORED_NOT_TERMINAL"); }
  if (kind === "unexpected") { await finish("failed_retryable", { errorCode: "UNEXPECTED_EVENT_TYPE" }); return reply(503, "UNEXPECTED_EVENT_TYPE"); }

  let intentId = null;
  try {
    const at = await attemptFor(pool, obj);
    if (at.foreign) { await finish("ignored", { errorCode: "NOT_A_MARAVILLA_SESSION" }); return reply(200, "IGNORED_FOREIGN_SESSION"); }
    if (!at.attempt) throw coded(at.code);
    const attempt = at.attempt;
    intentId = attempt.intent_id;
    await verifyAccount(stripe, accountId, accountCache);
    const s = await verifiedRead(pool, intentId, { opType: "stripe.retrieve_checkout_session", kind: "checkout_session", ref: obj.id,
      fetch: () => stripe.checkout.sessions.retrieve(obj.id), observe: sessionObservation, now, workerId });

    if (kind === "expiry") {
      if (s.obj.status !== "expired") throw coded(s.obj.status === "complete" ? "SESSION_COMPLETE_NOT_EXPIRED" : "SESSION_NOT_EXPIRED");
      const r = await applyCheckoutSessionEvidence(pool, intentId, attempt.id, s.evidenceId, { now, config });
      if (!r.ok) throw coded(r.error);
      await finish("processed", { intentId });
      return reply(200, "EXPIRY_APPLIED", { state: (await loadIntent(pool, intentId)).status });
    }

    // authorization
    const piId = typeof s.obj.payment_intent === "string" ? s.obj.payment_intent : isObj(s.obj.payment_intent) ? s.obj.payment_intent.id : null;
    if (!isPaymentIntentId(piId)) throw coded("SESSION_WITHOUT_PAYMENT_INTENT");
    const p = await verifiedRead(pool, intentId, { opType: "stripe.retrieve_payment_intent", kind: "payment_intent", ref: piId,
      fetch: () => stripe.paymentIntents.retrieve(piId, { expand: ["latest_charge"] }), observe: paymentIntentObservation, now, workerId });
    const b = bindAuthorization({ stripeEventId: event.id, session: s.obj, pi: p.obj, attempt, accountVerified: true });
    if (!b.ok) throw coded(b.code);
    if (hooks.beforeApply) await hooks.beforeApply();
    const res = await applyEvent(pool, intentId, b.event, { now, config, actor: "webhook",
      inTx: async (c) => {
        await markStripeEventProcessedInTx(c, event.id, { intentId, now });
        if (hooks.inTx) await hooks.inTx(c);
      } });
    if (!res.ok) throw coded(res.error === "ILLEGAL_TRANSITION" ? `NOT_APPLICABLE_IN_${String(res.intent?.status || "UNKNOWN").toUpperCase()}` : res.error);
    if (res.duplicate) {
      if (hooks.beforeDuplicateFinish) await hooks.beforeDuplicateFinish();
      await finish("processed", { intentId });
      return reply(200, "DUPLICATE", { state: res.intent.status });
    }
    return reply(200, "APPLIED", { state: res.intent.status });
  } catch (e) {
    const code = safeCode(e);
    await finish("failed_retryable", { errorCode: code, intentId }).catch(() => {});
    return reply(503, code);
  }
}

/**
 * startTestCheckout(pool, intentId, { env, stripe, now, workerId?, accountCache? })
 *   -> { ok:true, sessionId, url?, reused } | { ok:false, error }
 * One create per payment attempt, through the outbox row (claimed, executed once, completed). Never retried here:
 * an ambiguous result leaves the row outcome_unknown with a reconciliation case (beginPayStep then refuses).
 *
 * Order (each step fails closed before the next): environment gate -> the database must be marked 'test' -> the
 * injected client must belong to the configured TEST account -> only then any database write or Stripe create.
 * TRUST ASSUMPTION (explicit): the injected client is the one built from the gate's test-mode key. The key's text alone
 * does not prove what an injected object will do; the account read and every reply's livemode=false are checked, but
 * a caller that injects a different client is outside this function's control.
 */
export async function startTestCheckout(pool, intentId, deps) {
  const gate = stripeTestGate(deps.env);
  if (!gate.ok) return { ok: false, error: gate.code };              // before any database or Stripe call
  const { stripe, now } = deps;
  if (!Number.isFinite(now)) throw new TypeError("now required");
  try { await assertEnvironment(pool, "test"); } catch { return { ok: false, error: "DATABASE_NOT_TEST" }; }
  try { await verifyAccount(stripe, gate.config.accountId, deps.accountCache || null); } catch (e) { return { ok: false, error: safeCode(e) }; }
  const workerId = deps.workerId || `pay-${randomUUID().slice(0, 8)}`;
  const b = await beginPayStep(pool, intentId, { now });
  if (!b.ok) {
    // a repeated "pay" request after the session was prepared: the same session, never a second create
    if (b.error === "NOT_READY_FOR_PAYMENT" && b.state === "payment_pending") {
      const intent = await loadIntent(pool, intentId);
      const sid = intent.checkout ? intent.checkout.sessionId : null;
      const a = isTestSessionId(sid) ? await findAttemptBySession(pool, sid) : null;
      const v = reusable(a, intentId, now);
      return v ? { ok: false, error: v } : { ok: true, reused: true, sessionId: sid };
    }
    return { ok: false, error: b.error };
  }
  const attempt = b.attempt;
  if (b.reused && attempt.status === "open") {
    // the session exists; finish a CHECKOUT_PREPARED that an earlier crash may have left unapplied (same event id).
    // Reuse never extends, reprices or recreates a session: an expired one is not reused.
    const v = reusable(attempt, intentId, now);
    if (v) return { ok: false, error: v };
    const intent = await loadIntent(pool, intentId);
    if (intent.status === "details_collected") {
      const r = await applyEvent(pool, intentId, { type: "CHECKOUT_PREPARED", id: `cs-prepared:${attempt.checkout_session_id}`, sessionId: attempt.checkout_session_id },
        { now, actor: "guest" });
      if (!r.ok) return { ok: false, error: r.error };
    }
    return { ok: true, reused: true, sessionId: attempt.checkout_session_id };
  }
  const row = await findCheckoutCreateForAttempt(pool, intentId, attempt.id);
  if (row && row.state === "succeeded" && attempt.status === "creating") {
    // Crash after the create succeeded and was completed, before the session was recorded: finish recording it from a
    // fresh READ of that exact session (never a second create).
    return recordAfterInterruptedCreate(pool, intentId, attempt, row.result_ref, { stripe, now });
  }
  if (!row || row.state !== "pending") return { ok: false, error: "CHECKOUT_CREATE_IN_PROGRESS" };
  const op = await claimNextOperation(pool, { workerId, now, opId: row.id });
  if (!op) return { ok: false, error: "CHECKOUT_CREATE_IN_PROGRESS" };
  const executor = createCheckoutSessionExecutor({ stripe, nowMs: now, returnUrl: gate.config.returnUrl });
  let outcome;
  try { outcome = await dispatchOperation(op, { executors: { [CHECKOUT_CREATE_OP]: executor } }); }
  catch { outcome = { status: "outcome_unknown", errorCode: "EXECUTOR_FAILED" }; }
  if (deps.hooks?.afterSend) await deps.hooks.afterSend(outcome);
  const done = await completeOperation(pool, op.id, { workerId, now, outcome: { status: outcome.status, resultRef: outcome.resultRef ?? null, errorCode: outcome.errorCode ?? null } });
  if (!done.ok) return { ok: false, error: done.error };
  if (outcome.status !== "succeeded") return { ok: false, error: outcome.errorCode, state: done.state };
  if (deps.hooks?.beforeRecord) await deps.hooks.beforeRecord();
  const r = await recordCheckoutSession(pool, intentId, attempt.id, { sessionId: outcome.session.id, expiresAt: outcome.session.expiresAtMs, now });
  if (!r.ok) return { ok: false, error: r.error };
  return { ok: true, reused: false, sessionId: outcome.session.id, url: outcome.session.url };
}

/** An existing session may be handed out again only while its attempt is open, bound to this intent and unexpired. */
function reusable(a, intentId, now) {
  if (!a || a.intent_id !== intentId || a.status !== "open" || !isTestSessionId(a.checkout_session_id)) return "SESSION_NOT_REUSABLE";
  if (!a.session_expires_at || !(new Date(a.session_expires_at).getTime() > now)) return "SESSION_EXPIRED_NOT_REUSABLE";
  return null;
}

async function recordAfterInterruptedCreate(pool, intentId, attempt, sessionId, { stripe, now }) {
  if (!isTestSessionId(sessionId)) return { ok: false, error: "RECORDED_SESSION_ID_INVALID" };
  let sess;
  try { sess = await stripe.checkout.sessions.retrieve(sessionId); } catch { return { ok: false, error: "STRIPE_READ_FAILED" }; }
  if (!isObj(sess) || sess.object !== "checkout.session" || sess.id !== sessionId || sess.livemode !== false || sess.mode !== "payment"
      || sess.client_reference_id !== intentId || !isObj(sess.metadata)
      || sess.metadata.mv_intent_id !== intentId || sess.metadata.mv_payment_attempt_id !== attempt.id) return { ok: false, error: "RECORDED_SESSION_NOT_BOUND" };
  // the session must charge exactly the attempt's (= the confirmed price's) amount and currency
  if (!Number.isSafeInteger(sess.amount_total) || sess.amount_total !== Number(attempt.amount_minor)
      || typeof sess.currency !== "string" || sess.currency.toUpperCase() !== String(attempt.currency).trim()) return { ok: false, error: "RECORDED_SESSION_AMOUNT_MISMATCH" };
  if (sess.status !== "open" || !Number.isSafeInteger(sess.expires_at)) return { ok: false, error: "RECORDED_SESSION_NOT_OPEN" };
  if (!(sess.expires_at * 1000 > now) || sess.expires_at * 1000 - now > 24 * 60 * 60 * 1000) return { ok: false, error: "RECORDED_SESSION_EXPIRY_INVALID" };
  const r = await recordCheckoutSession(pool, intentId, attempt.id, { sessionId, expiresAt: sess.expires_at * 1000, now });
  if (!r.ok) return { ok: false, error: r.error };
  return { ok: true, reused: true, recovered: true, sessionId };
}
