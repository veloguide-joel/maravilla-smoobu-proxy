// P1 / 0029: taxed totals in booking.intents. Throwaway local PostgreSQL only.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startMigratedDatabase } from "./harness.mjs";
import * as F from "./fixtures.mjs";
import { applyEvent, loadIntent } from "../../lib/booking-db/repo.js";
import { migrateDown } from "../../db/lib/migrate.js";

let db;
before(async () => { db = await startMigratedDatabase(); });
after(async () => { await db.close(); });

const taxed = (stay = {}) => { const p = F.priceFor(stay);     // 6400.00 - 640.00 = 5760.00 pre-tax; IVA 921.60 + ISH 288.00 = 1209.60
  return { ...p, version: "final-price-v2", preTaxTotalMinor: 576000, taxMinor: 120960, taxPolicyVersion: "mx-iva16-ish5-v1",
    taxComponents: [{ code: "IVA", label: "IVA (16%)", rateBps: 1600, amountMinor: 92160 }, { code: "ISH", label: "State lodging tax (5%)", rateBps: 500, amountMinor: 28800 }],
    finalTotalMinor: 696960, lines: [...p.lines, { kind: "tax", code: "mx-iva16-ish5-v1", label: "Taxes", amountMinor: 120960 }],
    charge: { ...p.charge, amountMinor: 696960 }, quoteHash: "c".repeat(64) }; };
const row = async (id) => (await db.owner.query("SELECT standard_total_minor::int AS s, discount_minor::int AS d, tax_minor::int AS t, final_total_minor::int AS f, price_snapshot ->> 'taxPolicyVersion' AS v FROM booking.intents WHERE id = $1", [id])).rows[0];
let n = 0; const stay = () => { n += 1; const d = String(n).padStart(2, "0"); return { from: `2027-01-${d}`, to: `2027-02-${d}` }; };   // distinct stays (nights unchecked by the fixture)

test("X1 a taxed price is stored: tax_minor is derived from the price object and standard - discount + tax = final", async () => {
  const s = { from: "2026-12-20", to: "2026-12-24" };
  const id = await F.newIntent(db.app, s);
  F.ok(await applyEvent(db.app, id, { type: "PRICE_CONFIRMED", price: taxed(s) }, { now: F.at(0), actor: "guest" }), "taxed price");
  assert.deepEqual(await row(id), { s: 640000, d: 64000, t: 120960, f: 696960, v: "mx-iva16-ish5-v1" });
  const i = await loadIntent(db.app, id);
  assert.deepEqual([i.status, i.price.finalTotalMinor, i.price.taxMinor, i.price.version], ["price_confirmed", 696960, 120960, "final-price-v2"]);
});

test("X2 an untaxed (pre-P1) price is unchanged: tax_minor 0, the old arithmetic", async () => {
  const s = { listingId: 603567, from: "2026-12-20", to: "2026-12-24" };
  const id = await F.priced(db.app, s);
  assert.deepEqual(await row(id), { s: 640000, d: 64000, t: 0, f: 576000, v: null });
});

test("X3 the database refuses a price whose tax does not reconcile, names no policy, or carries a policy with no tax", async () => {
  const bad = [
    ["total without its tax", (p) => ({ ...p, finalTotalMinor: 576000, charge: { ...p.charge, amountMinor: 576000 } })],
    ["tax off by one", (p) => ({ ...p, taxMinor: 120961 })],
    ["tax with no policy version", (p) => { const { taxPolicyVersion, ...r } = p; return r; }],
    ["policy with zero tax", (p) => ({ ...p, taxMinor: 0, finalTotalMinor: 576000 })],
    ["negative tax", (p) => ({ ...p, taxMinor: -100, finalTotalMinor: 575900 })],
    ["wrong price version", (p) => ({ ...p, version: "final-price-v1" })],
    ["pre-tax total not standard - discount", (p) => ({ ...p, preTaxTotalMinor: 576001 })]
  ];
  for (const [name, f] of bad) {
    const s = { listingId: 603568, ...stay() };
    const id = await F.newIntent(db.app, s);
    await assert.rejects(applyEvent(db.app, id, { type: "PRICE_CONFIRMED", price: f(taxed(s)) }, { now: F.at(0), actor: "guest" }), /price_arithmetic|price_tax_policy|price_snapshot_matches/, name);
    assert.equal((await loadIntent(db.app, id)).status, "created", name);
  }
  // tax_minor cannot be written apart from the price object
  await assert.rejects(db.owner.query("UPDATE booking.intents SET tax_minor = 1"), /generated|can only be updated to DEFAULT/i);
});

test("X4 the 0029 down is refused while a taxed price exists and changes nothing", async () => {
  const own = await db.owner.connect();
  try { await assert.rejects(migrateDown(own, { env: "test", to: 28 }), /MIGRATION_0029_DOWN_REFUSED/); } finally { own.release(); }
  assert.equal((await db.owner.query("SELECT count(*)::int AS c FROM booking.intents WHERE tax_minor > 0")).rows[0].c, 1);
});
