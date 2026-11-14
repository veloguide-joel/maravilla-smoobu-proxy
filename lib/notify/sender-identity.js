// lib/notify/sender-identity.js — E7 C54: the ONE approved real SENDER identity for the gn-v2 Resend path (ROOT technical choice under Joel's
// delegation, 2026-11-14). Pure, no imports, no environment. Exact lowercase address + exact display name; no suffix / wildcard / any-domain /
// case-folding / env override. HONEST LABEL: accepting this identity in source is NOT domain verification, NOT sender readiness and NOT a permission
// to send — the Resend domain `mail.maravillanayarit.com` exists UNVERIFIED (DNS not published) at the time of this change. The RECIPIENT scope is
// unchanged everywhere (`.invalid` only, incl. SQL); this module never widens it. Only the gn-v2 + branded Resend provider-executor path may use it
// (enforced by the notification worker gate); the gn-v1 / mock paths keep the synthetic `.invalid` sender only.
export const APPROVED_REAL_SENDER = Object.freeze({ fromAddress: "bookings@mail.maravillanayarit.com", fromName: "maraVilla" });
/** isApprovedRealSender(fromAddress, fromName) → true ONLY for the exact approved pair (strict string equality; anything else false) */
export function isApprovedRealSender(fromAddress, fromName) {
  return typeof fromAddress === "string" && typeof fromName === "string"
    && fromAddress === APPROVED_REAL_SENDER.fromAddress && fromName === APPROVED_REAL_SENDER.fromName;
}
