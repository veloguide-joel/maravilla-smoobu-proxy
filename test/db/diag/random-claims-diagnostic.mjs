// Test-only diagnostic for concurrency.test.mjs "12 random concurrent claims" (NOT part of npm run test:db: lives in a
// subdirectory the *.test.mjs glob does not reach). Re-runs the exact 12-claim scenario on fresh listings for a bounded
// number of iterations against the disposable local PostgreSQL, with an instrumented pool that records every SQL error
// (SQLSTATE, statement, intent) per transaction. Production code is not modified; no provider calls.
// Usage: node test/db/diag/random-claims-diagnostic.mjs <iterations> <label>
import { startMigratedDatabase } from "../harness.mjs";
import * as F from "../fixtures.mjs";
import { beginPayStep } from "../../../lib/booking-db/repo.js";
import { DB_CONFIG } from "../../../lib/booking-db/config.js";

const N = Number(process.argv[2] || 50); const label = process.argv[3] || "solo";
// --simulate-listing-lock: TEST-ONLY simulation of the fix proposal (a per-listing transaction advisory lock taken just
// before the claim insert). Injected by this wrapper; production code is unchanged.
const SIM = process.argv.includes("--simulate-listing-lock");
const db = await startMigratedDatabase();
const errors = []; let txSeq = 0;
const instrumented = {
  query: (...a) => db.app.query(...a),
  connect: async () => {
    const c = await db.app.connect(); const tx = ++txSeq; const orig = c.query.bind(c); const rel = c.release.bind(c); let intent = null;
    c.query = async (text, params) => {
      if (!intent && params && typeof params[0] === "string" && /^[0-9a-f-]{36}$/.test(params[0])) intent = params[0];
      if (SIM && /INSERT INTO booking\.inventory_claims/.test(String(typeof text === "string" ? text : text.text)))
        await orig("SELECT pg_advisory_xact_lock(hashtext('booking.inventory_claims'), $1::int)", [params[1]]);
      try { return await orig(text, params); }
      catch (e) { errors.push({ tx, intent, code: e.code, msg: e.message, detail: e.detail, sql: String(typeof text === "string" ? text : text.text).replace(/\s+/g, " ").slice(0, 90) }); throw e; }
    };
    c.release = (...a) => { c.query = orig; c.release = rel; return rel(...a); };
    return c;
  }
};
const days = (n) => new Date(Date.UTC(2027, 7, 1) + n * 86400000).toISOString().slice(0, 10);
const summary = { label, simulateListingLock: SIM, iterations: 0, failures: 0, casMaxRetries: DB_CONFIG.casMaxRetries, codesSeen: {}, maxErrorsPerIntent: 0 };
try {
  for (let k = 0; k < N; k++) {
    const listingId = 760000 + k; const ids = [];
    for (let i = 0; i < 12; i++) { const s = (i * 7) % 20; const len = 2 + (i % 4); ids.push(await F.withDetails(db.app, { listingId, from: days(s), to: days(s + len) })); }
    const e0 = errors.length;
    const settled = await Promise.allSettled(ids.map((id) => beginPayStep(instrumented, id, { now: F.at(2) })));
    const errs = errors.slice(e0);
    for (const e of errs) summary.codesSeen[e.code] = (summary.codesSeen[e.code] || 0) + 1;
    const perIntent = {}; for (const e of errs) if (e.code !== "23P01") perIntent[e.intent] = (perIntent[e.intent] || 0) + 1;
    summary.maxErrorsPerIntent = Math.max(summary.maxErrorsPerIntent, ...Object.values(perIntent), 0);
    const outcomes = settled.map((s, i) => s.status === "fulfilled" ? (s.value.ok ? "ok" : s.value.error) : `THROWN:${s.reason.code}:${s.reason.message}`);
    const testWouldFail = settled.some((s) => s.status === "rejected") || settled.some((s) => !(s.value.ok || s.value.error === "DATES_CLAIMED"));
    const overlaps = await F.count(db.app, `SELECT count(*) AS n FROM booking.inventory_claims x JOIN booking.inventory_claims y ON x.id < y.id AND x.listing_id = y.listing_id
      AND x.stay && y.stay WHERE x.released_at IS NULL AND y.released_at IS NULL AND x.listing_id = $1`, [listingId]);
    summary.iterations++;
    if (testWouldFail || overlaps) {
      summary.failures++;
      const rows = async (sql) => (await db.app.query(sql, [ids])).rows;
      console.log(JSON.stringify({ FAILURE: { iteration: k, listingId, overlaps, outcomes: outcomes.map((o, i) => [i, ids[i].slice(0, 8), o]),
        errorsByTx: errs.map((e) => ({ ...e, intent: e.intent && e.intent.slice(0, 8) })),
        claims: await rows("SELECT left(intent_id::text,8) AS intent, stay::text, released_at FROM booking.inventory_claims WHERE intent_id = ANY($1) ORDER BY stay"),
        attempts: await rows("SELECT left(intent_id::text,8) AS intent, attempt, status FROM booking.payment_attempts WHERE intent_id = ANY($1) ORDER BY 1"),
        outbox: await rows("SELECT left(intent_id::text,8) AS intent, op_type, state FROM booking.external_operations WHERE intent_id = ANY($1) AND op_type = 'stripe.create_checkout_session' ORDER BY 1"),
        intents: await rows("SELECT left(id::text,8) AS intent, state, version FROM booking.intents WHERE id = ANY($1) ORDER BY 1") } }, null, 1));
      break;   // stop at the first failure with full evidence
    }
  }
} finally { console.log(JSON.stringify({ SUMMARY: summary })); await db.close(); }
