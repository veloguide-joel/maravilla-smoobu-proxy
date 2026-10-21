// db/lib/admin.js — Stage E2B.1. OWNER-ONLY reconciliation (C1, C4, C7).
//
// These calls must use a connection whose login holds mv_booking_admin — never the runtime credential.
// Each decision is a SECURITY DEFINER function that validates the cited, persisted provider evidence and records a
// reconciliation_resolutions row (resolver, justification, evidence ids, session user, time). The runtime role has no
// EXECUTE on them, and the database refuses to settle uncertain operations or leave reconciliation without one.
//
// TRUST BOUNDARY: dashboard evidence is the owner's attested observation (with an external reference); the database
// records who attested what, but cannot see the provider dashboard itself.

function codeOf(e) {
  const m = /^([A-Z_0-9]+)/.exec(e.message || "");
  return m ? m[1] : null;
}
async function call(pool, sql, params) {
  try { return { ok: true, id: (await pool.query(sql, params)).rows[0].id }; }
  catch (e) {
    if (["23514", "0A000", "22023", "42501"].includes(e.code) || /permission denied/.test(e.message)) {
      return { ok: false, error: e.code === "42501" || /permission denied/.test(e.message) ? "PERMISSION_DENIED" : codeOf(e), detail: e.message };
    }
    throw e;
  }
}

/** Owner-attested dashboard evidence (source *_dashboard), with attestation and an external reference. */
export function adminRecordEvidence(adminPool, { intentId, kind, externalRef, status, observed, observedAt, attestedBy, reference }) {
  return call(adminPool, "SELECT booking.admin_record_evidence($1,$2,$3,$4,$5,$6,$7,$8) AS id",
    [intentId, kind, externalRef, status, observed, new Date(observedAt), attestedBy, reference]);
}

/** Settle an outcome_unknown/escalated provider operation as 'succeeded' or 'failed_definite', citing evidence ids. */
export function adminResolveOperation(adminPool, { operationId, decision, evidenceIds, resultRef = null, resolver, justification, at }) {
  return call(adminPool, "SELECT booking.admin_resolve_operation($1,$2,$3,$4,$5,$6,$7) AS id",
    [operationId, decision, evidenceIds, resultRef == null ? null : String(resultRef), resolver, justification, new Date(at)]);
}

/** Decide an intent in reconciliation_required ('confirmed' | 'released' | 'cancelled'), citing evidence ids. */
export function adminResolveIntent(adminPool, { intentId, decision, evidenceIds, resultRef = null, resolver, justification, at }) {
  return call(adminPool, "SELECT booking.admin_resolve_intent($1,$2,$3,$4,$5,$6,$7) AS id",
    [intentId, decision, evidenceIds, resultRef == null ? null : String(resultRef), resolver, justification, new Date(at)]);
}

/** Re-acquire the nights for an intent the owner is about to confirm (exclusion constraint still applies). */
export async function adminAcquireClaim(adminPool, { intentId, at }) {
  try { await adminPool.query("SELECT booking.admin_acquire_claim($1, $2)", [intentId, new Date(at)]); return { ok: true }; }
  catch (e) { if (e.code === "23P01") return { ok: false, error: "DATES_CLAIMED" }; if (e.code === "23514") return { ok: false, error: codeOf(e) }; throw e; }
}

/** Close a non-operation case (e.g. CLAIM_UNRESOLVED) citing evidence. Releases nothing by itself. */
export function adminCloseCase(adminPool, { caseId, evidenceIds, resolver, justification, at }) {
  return call(adminPool, "SELECT booking.admin_close_case($1,$2,$3,$4,$5) AS id", [caseId, evidenceIds, resolver, justification, new Date(at)]);
}
