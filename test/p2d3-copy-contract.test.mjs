// P2d-3: the "bcc-v2" booking-confirmation copy (MiCasaDirect, taxes included, the owner's cancellation policy) and its request binding.
import test from "node:test";
import assert from "node:assert/strict";
import { renderBookingConfirmation, renderBookingConfirmationV2, COPY_CONTRACT_VERSION_V2, BRAND_V2, CANCELLATION_CONTACT } from "../lib/checkout/booking-confirmation-copy.js";
import { buildBookingConfirmationRequest, buildBookingConfirmationRequestBcc2, buildLiveBookingConfirmationRequestBcc2, COPY_CONTRACTS, contentHashV2 } from "../lib/checkout/booking-confirmation-request.js";

const facts = () => ({ ref: "MV-ABCDEF12", checkIn: "2026-12-10", checkOut: "2026-12-11", nights: 1, guests: 1, totalMinor: 16940, currency: "USD" });
const OP = "11111111-2222-4333-8444-555555555555";

test("P2d-3 copy en: brand, taxes included, the approved policy and the contact; bcc-v1 is untouched", () => {
  const r = renderBookingConfirmationV2({ template: "booking_confirmed", locale: "en", facts: facts() });
  assert.equal(r.ok, true);
  assert.deepEqual([r.copy.contractVersion, COPY_CONTRACT_VERSION_V2, BRAND_V2, CANCELLATION_CONTACT], ["bcc-v2", "bcc-v2", "MiCasaDirect", "info@micasadirect.com"]);
  assert.equal(r.copy.subject, "Your MiCasaDirect booking MV-ABCDEF12 is confirmed");
  assert.deepEqual(r.copy.text.split("\n"), [
    "Your MiCasaDirect booking MV-ABCDEF12 is confirmed.", "Booking reference: MV-ABCDEF12", "Check-in: 2026-12-10", "Check-out: 2026-12-11", "Nights: 1", "Guests: 1",
    r.copy.text.split("\n")[6], "",
    "Cancellation policy",
    "To cancel, email info@micasadirect.com with your booking reference.",
    "90 days or more before arrival: we refund the amount you paid, including taxes, less a cancellation fee of US$250 plus 16% IVA (US$290 in total).",
    "89 days or fewer before arrival: no refund. The amount you paid, less the same US$290 fee, becomes a credit toward a new stay at the same property. The new stay must begin within one year of your original arrival date. The credit cannot be used at any other property.",
    "", "MiCasaDirect"]);
  assert.match(r.copy.text.split("\n")[6], /^Payment received: .*169\.40.* \(taxes included\)$/);
  const v1 = renderBookingConfirmation({ template: "booking_confirmed", locale: "en", facts: facts() });
  assert.equal(v1.copy.contractVersion, "bcc-v1"); assert.ok(v1.copy.text.includes("maraVilla") && !v1.copy.text.includes("Cancellation"));
});

test("P2d-3 copy es: the same structure in Spanish; same refusals as bcc-v1", () => {
  const r = renderBookingConfirmationV2({ template: "booking_confirmed", locale: "es", facts: facts() });
  assert.equal(r.ok, true);
  const lines = r.copy.text.split("\n");
  assert.equal(lines.length, 14);
  assert.equal(r.copy.subject, "Tu reservación de MiCasaDirect MV-ABCDEF12 está confirmada");
  assert.match(lines[6], /^Pago recibido: .*169\.40.* \(impuestos incluidos\)$/);
  assert.deepEqual([lines[8], lines[9]], ["Política de cancelación", "Para cancelar, escribe a info@micasadirect.com con tu referencia de reservación."]);
  assert.ok(lines[10].includes("US$290 en total") && lines[11].includes("dentro de un año a partir de tu fecha de llegada original"));
  for (const [bad, code] of [[{ template: "x", locale: "en", facts: facts() }, "TEMPLATE_INVALID"], [{ template: "booking_confirmed", locale: "fr", facts: facts() }, "LOCALE_INVALID"],
    [{ template: "booking_confirmed", locale: "en", facts: { ...facts(), nights: 2 } }, "NIGHTS_MISMATCH"], [{ template: "booking_confirmed", locale: "en", facts: { ...facts(), extra: 1 } }, "FACTS_SHAPE"]]) {
    assert.deepEqual(renderBookingConfirmationV2(bad), renderBookingConfirmation(bad)); assert.equal(renderBookingConfirmationV2(bad).code, code);
  }
});

test("P2d-3 request: the Bcc2 builders bind bcc-v2 into the request and its hash; recipient scope is unchanged", () => {
  assert.deepEqual([...COPY_CONTRACTS], ["bcc-v1", "bcc-v2"]);
  const sender = { fromAddress: "bookings@mail.micasadirect.com", fromName: "MiCasaDirect" };
  const base = { template: "booking_confirmed", locale: "en", facts: facts(), sender, opId: OP };
  const t = buildBookingConfirmationRequestBcc2({ ...base, guest: { email: "delivered@resend.dev", firstName: "Ana" } });
  assert.equal(t.ok, true); assert.equal(t.request.copyContractVersion, "bcc-v2"); assert.equal(t.contentHash, contentHashV2(t.request));
  const old = buildBookingConfirmationRequest({ ...base, guest: { email: "delivered@resend.dev", firstName: "Ana" } });
  assert.equal(old.request.copyContractVersion, "bcc-v1"); assert.notEqual(old.contentHash, t.contentHash);
  assert.equal(buildBookingConfirmationRequestBcc2({ ...base, guest: { email: "guest@example.com", firstName: "Ana" } }).code, "RECIPIENT_INVALID", "TEST scope never admits a real address");
  const live = buildLiveBookingConfirmationRequestBcc2({ ...base, guest: { email: "guest@example.com", firstName: "Ana" } });
  assert.equal(live.ok, true); assert.equal(live.request.copyContractVersion, "bcc-v2");
  assert.equal(buildLiveBookingConfirmationRequestBcc2({ ...base, guest: { email: "delivered@resend.dev", firstName: "Ana" } }).code, "RECIPIENT_INVALID");
});
