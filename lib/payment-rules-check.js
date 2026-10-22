// E4 payment isolation — pure summarizer for GET /v1/guestPayments/autoPayment ("Get auto-payment rules").
//
// Source (official reference, read 2026-10-22, https://api.hostaway.com/documentation, section "Get auto-payment
// rules"): GET https://api.hostaway.com/v1/guestPayments/autoPayment, no documented query parameters. Response
// "Guest auto invoice auto charge list": { status: "success", result: [ <auto charge object> ... ], count, offset }.
// The documented auto charge object has id, accountId, guestAutoInvoiceId, type (charge | preAuth), title,
// description, triggerEvent, triggerTimeDelta, paymentMethod, paymentProvider, flatFee, percentageFee, isRestOfPay,
// insertedOn, updatedOn. It documents NO listing or channel scope and NO listing filter.
//
// Output is ONLY our own fixed codes, the HTTP status and two counts, plus fixed flags. Nothing from a rule (titles,
// descriptions, account ids, providers, methods, amounts) and no provider string is ever copied.
//
// Verdicts:
//   NO_RULES_RETURNED      200, success envelope, result [], count 0. NOT proof of isolation (account-level list only;
//                          does not cover other payment paths, Stripe settings or anything undocumented).
//   RULES_PRESENT_UNSCOPED 200, success envelope, >= 1 well-formed rule, count consistent. The list has no listing
//                          scope, so no exemption of the test listing is inferred.
//   UNRESOLVED             anything else (non-200, fail/malformed envelope, missing/invalid/inconsistent count,
//                          malformed item, transport/auth failure). Never treated as "no rules".

export const PAYMENT_RULES_PATH = "/guestPayments/autoPayment";
export const VERDICTS = Object.freeze(["NO_RULES_RETURNED", "RULES_PRESENT_UNSCOPED", "UNRESOLVED"]);
export const REASONS = Object.freeze(["HTTP_NOT_OK", "FAIL_ENVELOPE", "MALFORMED_ENVELOPE", "COUNT_MISSING", "COUNT_INVALID",
  "COUNT_INCONSISTENT", "ITEM_MALFORMED", "AUTH_FAILED", "TRANSPORT_UNCERTAIN"]);
const MAX_COUNT = 10000;

const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v) &&
  (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);
const isPosInt = (v) => Number.isSafeInteger(v) && v > 0;

function result({ verdict, reason = null, httpStatus = null, returnedCount = null, declaredCount = null, countConsistent = "unknown" }) {
  return Object.freeze({
    verdict, reason, httpStatus, returnedCount, declaredCount, countConsistent,
    listingScopeDocumented: false,   // fixed: the documented rule object has no listing/channel scope
    isolationProven: false           // fixed: no outcome of this check proves payment isolation
  });
}

/** Summarize an error thrown by the provider client (token mint, network, timeout). */
export function summarizeThrown(err) {
  const code = typeof err?.code === "string" ? err.code : "";
  return result({ verdict: "UNRESOLVED", reason: /^HOSTAWAY_(AUTH|ENV)/.test(code) ? "AUTH_FAILED" : "TRANSPORT_UNCERTAIN" });
}

/** Summarize { status, json } as returned by lib/hostaway.js hostawayGet. */
export function summarizeAutoPaymentRules(httpStatus, json) {
  const status = Number.isSafeInteger(httpStatus) && httpStatus >= 100 && httpStatus <= 599 ? httpStatus : null;
  const unresolved = (reason, extra = {}) => result({ verdict: "UNRESOLVED", reason, httpStatus: status, ...extra });
  if (status !== 200) return unresolved("HTTP_NOT_OK");
  if (!isPlainObject(json) || typeof json.status !== "string") return unresolved("MALFORMED_ENVELOPE");
  if (json.status === "fail") return unresolved("FAIL_ENVELOPE");
  if (json.status !== "success" || !Array.isArray(json.result)) return unresolved("MALFORMED_ENVELOPE");
  const returnedCount = json.result.length;
  if (returnedCount > MAX_COUNT) return unresolved("MALFORMED_ENVELOPE");
  if (!Object.prototype.hasOwnProperty.call(json, "count") || json.count === null) return unresolved("COUNT_MISSING", { returnedCount });
  if (!Number.isSafeInteger(json.count) || json.count < 0 || json.count > MAX_COUNT) return unresolved("COUNT_INVALID", { returnedCount });
  const declaredCount = json.count;
  if (declaredCount !== returnedCount) return unresolved("COUNT_INCONSISTENT", { returnedCount, declaredCount, countConsistent: false });
  if (!json.result.every((r) => isPlainObject(r) && isPosInt(r.id))) {
    return unresolved("ITEM_MALFORMED", { returnedCount, declaredCount, countConsistent: true });
  }
  if (new Set(json.result.map((r) => r.id)).size !== returnedCount) {
    return unresolved("ITEM_MALFORMED", { returnedCount, declaredCount, countConsistent: true });
  }
  return result({ verdict: returnedCount === 0 ? "NO_RULES_RETURNED" : "RULES_PRESENT_UNSCOPED", httpStatus: status,
    returnedCount, declaredCount, countConsistent: true });
}
