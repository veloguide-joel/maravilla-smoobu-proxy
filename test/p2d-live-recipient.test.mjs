// P2d: LIVE recipient scope in the confirmation builder and the Resend executor. Offline: nothing is sent; the exchange is a counting fake.
import { test } from "node:test";
import assert from "node:assert/strict";
import { isLiveRecipient, isRecipientInScopeFor, LIVE_RECIPIENT_RE, SINK_RECIPIENT } from "../lib/checkout/guest-notification.js";
import { createResendNotificationExecutor } from "../lib/notify/resend-notification-executor.js";
import { NOTIFICATION_MODE_OPTION_KEY, NOTIFICATION_OPTION_KEYS } from "../lib/booking-db/notification-worker.js";
import * as BCR from "../lib/checkout/booking-confirmation-request.js";

test("R1 the LIVE scope is a real address and nothing else; the TEST scope is unchanged; an unknown mode means TEST", () => {
  for (const e of ["guest@example.com", "A.B+c@Example.MX"]) assert.deepEqual([isLiveRecipient(e), isRecipientInScopeFor(e, "live"), isRecipientInScopeFor(e, "test"), isRecipientInScopeFor(e, undefined), isRecipientInScopeFor(e, "prod")], [true, true, false, false, false], e);
  for (const e of ["x@example.invalid", "x@EXAMPLE.INVALID", SINK_RECIPIENT, "Delivered@Resend.dev", "", null, 5, "a@b", "x@example.com "]) assert.equal(isLiveRecipient(e), false, String(e));
  assert.deepEqual([isRecipientInScopeFor("x@example.invalid", "test"), isRecipientInScopeFor(SINK_RECIPIENT, "test"), isRecipientInScopeFor(SINK_RECIPIENT, "live")], [true, true, false]);
  assert.ok(LIVE_RECIPIENT_RE instanceof RegExp);
});

test("R2 the Resend executor: no `mode` = the accepted TEST executor; mode must be test | live; the builder has a separate LIVE entry point", () => {
  const never = async () => { throw new Error("no exchange is expected"); };
  const sender = { fromAddress: "bookings@mail.micasadirect.com", fromName: "MiCasaDirect" };
  const base = { exchange: never, credential: () => "re_placeholder", sender };
  const t = createResendNotificationExecutor(base);
  const withTest = createResendNotificationExecutor({ ...base, mode: "test" });
  const withLive = createResendNotificationExecutor({ ...base, mode: "live" });
  assert.deepEqual([t.ok, withTest.ok, withLive.ok], [t.ok, t.ok, t.ok], "mode never changes whether the same options construct");
  for (const bad of ["", "LIVE", "prod", null, 1]) assert.deepEqual(createResendNotificationExecutor({ ...base, mode: bad }), { ok: false, code: "EXECUTOR_OPTIONS_INVALID" }, String(bad));
  assert.deepEqual(createResendNotificationExecutor({ ...base, extra: 1 }), { ok: false, code: "EXECUTOR_OPTIONS_INVALID" });
  assert.equal(typeof BCR.buildLiveBookingConfirmationRequest, "function");
  assert.equal(BCR.buildLiveBookingConfirmationRequest({}).ok, false);
  assert.equal(NOTIFICATION_MODE_OPTION_KEY, "mode");
  assert.equal(NOTIFICATION_OPTION_KEYS.includes("mode"), false, "the accepted key list is unchanged; mode is a separate optional key");
});
