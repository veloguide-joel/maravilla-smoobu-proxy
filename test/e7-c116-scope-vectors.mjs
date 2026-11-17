// E7 C116 — the ONE shared recipient-scope vector table: JS isRecipientInScope (test/e7-c116-sink-recipient-scope.test.mjs) and SQL
// booking.gn_recipient_in_scope after 0025 (test/db/e7-c116-0025-sink-recipient-scope.test.mjs) must agree on every row. Data only.
/** [value, expected in scope] — shared verbatim with the SQL parity test */
export const SCOPE_VECTORS = Object.freeze([
  ["delivered@resend.dev", true], ["guest.n1@mv-test.invalid", true], ["a@b.invalid", true], ["x+y_z-1.2@a-b.c.invalid", true],
  ["Delivered@resend.dev", false], ["DELIVERED@RESEND.DEV", false], ["delivered@Resend.dev", false], [" delivered@resend.dev", false], ["delivered@resend.dev ", false],
  ["delivered@resend.dev\n", false], ["\ndelivered@resend.dev", false], ["delivered@resend.dev\t", false], ["delivered+x@resend.dev", false], ["delivered+@resend.dev", false],
  ["x@resend.dev", false], ["bounced@resend.dev", false], ["delivered@resend.dev.", false], ["delivered@resend.devx", false], ["delivered@mail.resend.dev", false],
  ["delivered@resend.dev.example", false], ["deliverеd@resend.dev", false], ["delivered@resend.dеv", false], ["delivered@resend.dev,a@b.invalid", false],
  ["delivered@resend.dev a@b.invalid", false], ["delivered@resend.dev\u0000", false], ["", false], ["a@b.example", false], ["A@b.invalid", false], ["a@b.invalid\n", false],
  [`${"a".repeat(64)}@${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(53)}.invalid`, true], [`${"a".repeat(64)}@${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(54)}.invalid`, false]]);   // exactly 254 / 255

