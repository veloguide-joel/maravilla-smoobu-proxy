// E7 C116 — the RECIPIENT-ONLY simulation-sink scope (lib/checkout/guest-notification.js isRecipientInScope). PURE, offline: no DB, no network.
// The sink is admitted ONLY as a gn-v2 RECIPIENT (builder guest email, executor wire `to`); RECIPIENT_RE, the gn-v1 builder and every SENDER rule are
// unchanged. The same vector table is checked against SQL booking.gn_recipient_in_scope on disposable PostgreSQL (test/db/e7-c116-0025-…).
import { test } from "node:test";
import assert from "node:assert/strict";
import { RECIPIENT_RE, SINK_RECIPIENT, isRecipientInScope, buildMessageRequest } from "../lib/checkout/guest-notification.js";
import { buildBookingConfirmationRequest } from "../lib/checkout/booking-confirmation-request.js";
import { createResendNotificationExecutor } from "../lib/notify/resend-notification-executor.js";
import { APPROVED_REAL_SENDER } from "../lib/notify/sender-identity.js";
import { SCOPE_VECTORS } from "./e7-c116-scope-vectors.mjs";

test("C116-U1 isRecipientInScope: exactly the sink OR the unchanged `.invalid` scope (same 254 bound); exact string equality — case / whitespace / newline / NUL / +label / subdomain / trailing dot / homoglyph / list all refused; non-strings false", () => {
  assert.equal(SINK_RECIPIENT, "delivered@resend.dev");
  assert.deepEqual(SCOPE_VECTORS.slice(-2).map(([v]) => v.length), [254, 255]);
  for (const [v, want] of SCOPE_VECTORS) assert.equal(isRecipientInScope(v), want, JSON.stringify(v));
  for (const v of [null, undefined, 1, {}, [], ["delivered@resend.dev"], new String("delivered@resend.dev")]) assert.equal(isRecipientInScope(v), false, String(v));
  assert.equal(RECIPIENT_RE.source, "^[a-z0-9._+-]{1,64}@([a-z0-9-]{1,63}\\.)+invalid$", "RECIPIENT_RE unchanged");
  assert.equal(RECIPIENT_RE.test("delivered@resend.dev"), false, "the sink is NOT added to RECIPIENT_RE (which also validates senders)");
});

const FACTS = Object.freeze({ ref: "MV-C116SINK", checkIn: "2030-01-10", checkOut: "2030-01-11", nights: 1, guests: 1, totalMinor: 14000, currency: "USD" });
const OP = "11111111-2222-4333-8444-555555555555";
const SYN = Object.freeze({ fromAddress: "bookings@sender.mv-test.invalid", fromName: "maraVilla Test" });
const v2 = (email, sender = SYN) => buildBookingConfirmationRequest({ template: "booking_confirmed", locale: "en", opId: OP, sender: { ...sender }, guest: { email, firstName: "Synthia" }, facts: { ...FACTS } });

test("C116-U2 gn-v2 builder: the sink is admitted as the guest RECIPIENT (request.to == the input, recipientHash bound to it); look-alikes refused RECIPIENT_INVALID; the sink is NEVER a sender (SENDER_INVALID) — synthetic and approved-real sender rules unchanged", () => {
  for (const sender of [SYN, APPROVED_REAL_SENDER]) {
    const r = v2("delivered@resend.dev", sender);
    assert.equal(r.ok, true); assert.equal(r.request.to === "delivered@resend.dev", true);
    assert.equal(r.recipientHash === v2("delivered@resend.dev", sender).recipientHash, true);
    assert.notEqual(r.contentHash, v2("guest.n1@mv-test.invalid", sender).contentHash, "the recipient is bound into the content hash");
  }
  for (const [v, want] of SCOPE_VECTORS) assert.equal(v2(v).ok, want, JSON.stringify(v));
  for (const fromName of ["MiCasaDirect", "maraVilla Test"]) assert.deepEqual(v2("guest.n1@mv-test.invalid", { fromAddress: "delivered@resend.dev", fromName }), { ok: false, code: "SENDER_INVALID" });
});

test("C116-U3 gn-v1 builder UNCHANGED: still `.invalid`-only for recipient and sender — the sink is refused in both roles", () => {
  const base = { template: "booking_confirmed", facts: { ref: "MV-C116SINK", checkIn: "2030-01-10", checkOut: "2030-01-11", nights: 1, guests: 1, totalMinor: 14000 }, opId: OP };
  const ok = buildMessageRequest({ ...base, guest: { email: "guest.n1@mv-test.invalid", firstName: "Synthia" }, sender: { ...SYN } });
  const sinkTo = buildMessageRequest({ ...base, guest: { email: "delivered@resend.dev", firstName: "Synthia" }, sender: { ...SYN } });
  const sinkFrom = buildMessageRequest({ ...base, guest: { email: "guest.n1@mv-test.invalid", firstName: "Synthia" }, sender: { fromAddress: "delivered@resend.dev", fromName: "maraVilla Test" } });
  assert.equal(sinkTo.ok, false, "v1 recipient refused"); assert.equal(sinkFrom.ok, false, "v1 sender refused");
  assert.equal(typeof ok.ok, "boolean");
});

test("C116-U4 Resend executor: wire `to` is EXACTLY the request recipient (the sink, no rewrite); a request whose `to` is a look-alike is refused RECIPIENT_SCOPE before the exchange; the sink is never an executor sender; ONE exchange ever (spent → no resend)", async () => {
  let calls = 0; const bodies = [];
  const exchange = async (req) => { calls += 1; bodies.push(Buffer.from(req.body).toString("utf8")); return { status: 200, headers: { contentType: "application/json", contentEncoding: null, idempotentReplayed: null }, body: Buffer.from('{"id":"5f0c1a2b-3c4d-4e5f-8a6b-000000000001"}') }; };
  const mk = (sender = APPROVED_REAL_SENDER) => createResendNotificationExecutor({ exchange, credential: () => "re_SENTINELkey0123456789", sender: { ...sender } });
  for (const fromName of ["MiCasaDirect", "maraVilla Test"]) assert.equal(mk({ fromAddress: "delivered@resend.dev", fromName }).ok, false, "sink as executor sender");
  const b = v2("delivered@resend.dev", APPROVED_REAL_SENDER); assert.equal(b.ok, true);
  const ex = mk().executor;
  const out = await ex.send({ request: b.request, opId: OP, contentHash: b.contentHash });
  assert.equal(out.kind, "accepted"); assert.equal(calls, 1);
  assert.equal(JSON.stringify(JSON.parse(bodies[0]).to) === JSON.stringify(["delivered@resend.dev"]), true, "wire to == request.to");
  const again = await ex.send({ request: b.request, opId: OP, contentHash: b.contentHash });
  assert.equal(again.kind, "refused"); assert.equal(calls, 1, "single-use: no second exchange");
  const forged = Object.freeze({ ...b.request, to: "delivered+x@resend.dev" });
  const r2 = await mk().executor.send({ request: forged, opId: OP, contentHash: b.contentHash });
  assert.equal(r2.kind, "refused"); assert.equal(calls, 1, "look-alike refused before any exchange");
});
