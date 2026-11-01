// E4 connected-listing PRECHECK CLI (scripts/e4-connected/connected-precheck.mjs) — OFFLINE ONLY. Stub fetch (synthetic
// Hostaway answers, NOT provider evidence), mock git/prompt/manifest/operator. The global fetch is a throwing spy.
// Dates/amounts/guest values below are synthetic test values (April 5->7 2027 coincides with root's 2026-11-01 Airbnb
// proposal; this test is not evidence of anything live).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve, dirname, relative } from "node:path";
import { spawnSync } from "node:child_process";

let globalFetchCalls = 0;
globalThis.fetch = () => { globalFetchCalls++; throw new Error("global fetch must not be used"); };
const P = await import("../scripts/e4-connected/connected-precheck.mjs");
const C = await import("../scripts/e4-connected/connected-path.mjs");
const R = await import("../scripts/e4-write-runner/runner.mjs");
const { runConnectedPrecheckCli, assertPrecheckRequest, guardFetch, boundShapes, checkPrecheckManifest, askAirbnbOnTty, CONNECTED_PRECHECK_SOURCES, CONNECTED_PRECHECK_EXIT: EXIT } = P;

const ROOT = new URL("..", import.meta.url).pathname;
const SHA = "e".repeat(40);
const NOW = () => new Date("2026-11-01T18:00:00.000Z");
const FAKE = { account: "98765", secret: "FAKE-secret-DO-NOT-LEAK", token: "FAKE-token-DO-NOT-LEAK" };
const GUEST = { firstName: "Synthetic", lastName: "Tester", email: "e4-synthetic@example.invalid" };
const LEAKS = [FAKE.account, FAKE.secret, FAKE.token, "Synthetic", "Tester", "example.invalid", "PROVIDER-TEXT", "Standin"];
const leakFree = (o) => { const s = JSON.stringify(o); for (const x of LEAKS) assert.ok(!s.includes(x), `leak: ${x}`); };
const manifest = (over = {}) => ({ ...C.connectedManifestTemplate(), guests: 2, totalMinor: 440000, window: { start: "2027-04-01", end: "2027-04-30" },
  stay: { arrivalDate: "2027-04-05", departureDate: "2027-04-07" }, guest: { ...GUEST }, reviewedCommit: SHA, ...over });
const REAL = spawnSync("git", ["hash-object", "--", ...CONNECTED_PRECHECK_SOURCES], { cwd: ROOT, encoding: "utf8" }).stdout.trim().split("\n");
const git = (opt = {}) => (a) => a[0] === "rev-parse" ? { status: 0, stdout: `${opt.head ?? SHA}\n` } : a[0] === "status" ? { status: 0, stdout: opt.dirty ? " M x\n" : "" }
  : a[0] === "ls-tree" ? { status: 0, stdout: CONNECTED_PRECHECK_SOURCES.map((p, i) => `100644 blob ${REAL[i]}\t${p}`).join("\n") } : { status: 0, stdout: REAL.join("\n") };

function world(over = {}) {
  const w = { log: [] };
  const ok = (result) => ({ status: "success", result });
  w.fetchImpl = async (url, init = {}) => {
    const u = new URL(String(url)); const m = init.method ?? "GET";
    w.log.push(`${m} ${u.pathname}${u.search}`);
    if (u.pathname === "/v1/accessTokens") return over.token ? over.token() : new Response(JSON.stringify({ access_token: FAKE.token }), { status: 200 });
    const send = (body, status = 200) => new Response(JSON.stringify(body), { status });
    if (m === "GET" && u.pathname === "/v1/listings/603566") return send(ok({ id: 603566, name: "PROVIDER-TEXT", currencyCode: "MXN", personCapacity: 2,
      airbnbListingUrl: "https://www.airbnb.com/rooms/1798070853315176756", ...(over.listing ?? {}) }));
    if (m === "POST" && u.pathname === "/v1/listings/603566/calendar/priceDetails") return send(ok({ totalPrice: over.price ?? 4400, components: "PROVIDER-TEXT" }));
    if (m === "GET" && u.pathname === "/v1/listings/603566/calendar") {
      const st = over.night ?? (() => "available");
      return send(ok(["2027-04-05", "2027-04-06"].map((date) => ({ date, status: st(date), isAvailable: st(date) === "available" ? 1 : 0, note: "PROVIDER-TEXT" }))));
    }
    if (m === "GET" && u.pathname === "/v1/reservations") {
      if (u.searchParams.has("afterId")) return send(ok([]));
      return send(ok(over.reservations ?? []));
    }
    return send({ status: "fail", result: "PROVIDER-TEXT" }, 404);
  };
  return w;
}
async function cli(argv, { w = world(), g = git(), m = manifest(), airbnb = "OPEN", prompt } = {}) {
  let prompts = 0, reads = 0, asked = 0;
  const r = await runConnectedPrecheckCli(argv, { git: g, now: NOW, readManifest: () => { reads++; return typeof m === "string" ? m : JSON.stringify(m); },
    fetchImpl: w.fetchImpl, sleep: async () => {}, timeoutMs: 200,
    prompt: prompt ?? (async () => { prompts++; return { accountId: FAKE.account, clientSecret: FAKE.secret }; }),
    airbnbCheckpoint: async () => { asked++; return typeof airbnb === "function" ? airbnb() : airbnb; } });
  return { r, prompts, reads, asked, w };
}
const PRE = ["--precheck", "--manifest", "m.json", "--reviewed-commit", SHA];
const DRY = ["--dry-run", "--manifest", "m.json", "--reviewed-commit", SHA];

test("usage: only --dry-run/--precheck with --manifest and --reviewed-commit; execution-style flags are refused before anything", async () => {
  for (const argv of [[], ["--execute", "--manifest", "m", "--reviewed-commit", SHA], ["--precheck", "--confirm", "x", "--reviewed-commit", SHA],
    ["--precheck", "--journal-dir", "j", "--reviewed-commit", SHA], [...PRE, "--execute"], ["--precheck", "--manifest", "m", "--manifest", "m2"],
    ["--precheck", "--manifest", "--reviewed-commit", SHA, "x"], ["--precheck", "--manifest", "m", "--reviewed-commit", "abc"]]) {
    const { r, prompts, reads, w } = await cli(argv);
    assert.equal(r.exitCode, EXIT.USAGE, argv.join(" "));
    assert.deepEqual([prompts, reads, w.log.length], [0, 0, 0]);
  }
});

test("provenance of the complete import closure comes first: wrong HEAD / dirty source => refused before manifest, prompt or network", async () => {
  for (const g of [git({ head: "f".repeat(40) }), git({ dirty: true })]) {
    const { r, prompts, reads, w } = await cli(PRE, { g });
    assert.deepEqual([r.exitCode, r.output.stage, prompts, reads, w.log.length], [EXIT.REFUSED, "provenance", 0, 0, 0]);
  }
});

test("manifest: strict code binding, fixed listing, concrete dates; only price and guest may be proposal placeholders", async () => {
  let { r, prompts } = await cli(PRE, { m: manifest({ reviewedCommit: "d".repeat(40) }) });
  assert.deepEqual([r.exitCode, r.output.manifestErrors, prompts], [EXIT.REFUSED, ["REVIEWED_COMMIT_NOT_BOUND"], 0]);
  ({ r } = await cli(PRE, { m: manifest({ listingId: 603564 }) }));
  assert.deepEqual(r.output.manifestErrors, ["FIXED_VALUE_MISMATCH:listingId"]);
  ({ r } = await cli(PRE, { m: { ...manifest(), stay: { arrivalDate: R.PLACEHOLDER, departureDate: R.PLACEHOLDER } } }));
  assert.ok(r.output.blockers.includes("OWNER_INPUT_REQUIRED:stay.arrivalDate"));
  ({ r } = await cli(PRE, { m: "{not json" }));
  assert.equal(r.output.error, "MANIFEST_NOT_JSON");
  const c = checkPrecheckManifest(manifest({ totalMinor: R.PLACEHOLDER, guest: { firstName: R.PLACEHOLDER, lastName: R.PLACEHOLDER, email: R.PLACEHOLDER } }), { now: NOW, reviewedCommit: SHA });
  assert.deepEqual([c.ok, c.proposal, c.manifestHash, c.totalMinor], [true, ["totalMinor", "guest.firstName", "guest.lastName", "guest.email"], null, null]);
  leakFree(c);
});

test("dry-run: zero credentials, zero network, nothing written; reports the plan and the proposal fields", async () => {
  const { r, prompts, w, asked } = await cli(DRY, { m: manifest({ totalMinor: R.PLACEHOLDER }) });
  assert.deepEqual([r.exitCode, r.output.network, r.output.credentialsRequested, r.output.filesWritten, prompts, w.log.length, asked], [EXIT.OK, "none", false, 0, 0, 0, 0]);
  assert.deepEqual([r.output.proposalFields, r.output.nights, r.output.executionWired], [["totalMinor"], ["2027-04-05", "2027-04-06"], false]);
  leakFree(r.output);
});

test("precheck: one token + exactly listing, price, calendar, lookup (to an empty page); all checks; codes only", async () => {
  const { r, w, prompts, asked } = await cli(PRE);
  assert.deepEqual([r.exitCode, r.output.ok, prompts, asked], [EXIT.OK, true, 1, 1]);
  assert.deepEqual(w.log.map((l) => l.split("?")[0]), ["POST /v1/accessTokens", "GET /v1/listings/603566", "POST /v1/listings/603566/calendar/priceDetails",
    "GET /v1/listings/603566/calendar", "GET /v1/reservations"]);
  const o = r.output;
  assert.deepEqual(o.checks, { listing: true, mappingNotContradicted: true, price: true, calendarOpen: true, arrivalClear: true, airbnbOpen: true });
  assert.deepEqual([o.listing.code, o.listing.currency, o.listing.capacity, o.listing.mapping], ["LISTING_OK", "MXN", 2, "AIRBNB_URL_MATCHES"]);
  assert.deepEqual([o.price.code, o.price.observedTotalMinor, o.priceMode], ["PRICE_MATCHES_MANIFEST", 440000, "bound"]);
  assert.deepEqual(o.calendar, { code: "CALENDAR_OPEN", nights: [{ date: "2027-04-05", code: "NIGHT_AVAILABLE_TRUE" }, { date: "2027-04-06", code: "NIGHT_AVAILABLE_TRUE" }] });
  assert.deepEqual([o.lookup.code, o.airbnb, o.refFieldStorage, o.filesWritten], ["NO_RESERVATION_ON_ARRIVAL_SEEN", { attested: "OPEN", source: "OPERATOR_ATTESTED" }, "UNPROVEN_WITHOUT_CREATE", 0]);
  assert.deepEqual(o.guard, { token: 1, listing: 1, price: 1, calendar: 1, lookup: 1, refused: 0 });
  assert.deepEqual([o.transportDiag, o.transportUsage], [null, { mintState: "ok", fetches: 5 }]);
  assert.ok(typeof o.manifestHash === "string" && o.manifestHash.length === 64);
  leakFree(o);
  assert.equal(globalFetchCalls, 0);
});

test("proposal mode: price placeholder => the observed MXN total is reported as a proposal for owner approval", async () => {
  const { r } = await cli(PRE, { m: manifest({ totalMinor: R.PLACEHOLDER, guest: { firstName: R.PLACEHOLDER, lastName: R.PLACEHOLDER, email: R.PLACEHOLDER } }), w: world({ price: 3812.5 }) });
  assert.deepEqual([r.exitCode, r.output.priceMode, r.output.price, r.output.manifestHash], [EXIT.OK, "proposal",
    { code: "PRICE_OBSERVED_PROPOSAL", observedTotalMinor: 381250, currency: "MXN" }, null]);
  leakFree(r.output);
});

test("every failed check is reported, never acted on (exit 3), and the Airbnb answer is independent of Hostaway", async () => {
  const cases = [
    ["price differs", { w: world({ price: 4500 }) }, (o) => o.price.code === "PRICE_DIFFERS_FROM_MANIFEST" && !o.checks.price],
    ["a night blocked", { w: world({ night: (d) => (d === "2027-04-06" ? "reserved" : "available") }) }, (o) => o.calendar.code === "CALENDAR_MIXED" && o.calendar.nights[1].code === "NIGHT_RESERVED_FALSE"],
    ["listing USD", { w: world({ listing: { currencyCode: "USD" } }) }, (o) => o.listing.code === "LISTING_MISMATCH" && o.listing.currency === "NOT_MXN"],
    ["capacity 1", { w: world({ listing: { personCapacity: 1 } }) }, (o) => !o.listing.capacityOk && !o.checks.listing],
    ["other id", { w: world({ listing: { id: 603564 } }) }, (o) => o.listing.idMatches === false],
    ["a reservation on the arrival date", { w: world({ reservations: [{ id: 5, listingMapId: 603566, channelId: 2000, arrivalDate: "2027-04-05", departureDate: "2027-04-07",
      totalPrice: 1, currency: "MXN", status: "new", customFieldValues: [] }] }) }, (o) => o.lookup.code === "OTHER_RESERVATIONS_ON_ARRIVAL" && o.lookup.itemsSeen === 1],
    ["Airbnb BLOCKED", { airbnb: "BLOCKED" }, (o) => o.airbnb.attested === "BLOCKED" && !o.checks.airbnbOpen],
    ["Airbnb free text", { airbnb: "maybe" }, (o) => o.airbnb.attested === "UNKNOWN"],
    ["Airbnb checkpoint throws", { airbnb: () => { throw new Error("x"); } }, (o) => o.airbnb.attested === "UNKNOWN"]
  ];
  for (const [name, opt, check] of cases) {
    const { r } = await cli(PRE, opt);
    assert.deepEqual([r.exitCode, r.output.ok], [EXIT.INCOMPLETE, false], name);
    assert.ok(check(r.output), name);
    leakFree(r.output);
  }
  // the documented link being absent is reported as unknown, not as a failure (and never as a readiness claim)
  const { r } = await cli(PRE, { w: world({ listing: { airbnbListingUrl: null } }) });
  assert.deepEqual([r.exitCode, r.output.listing.mapping], [EXIT.OK, "AIRBNB_URL_ABSENT_UNKNOWN"]);
});

test("price is labelled MXN (matched or proposed) only when this run read the listing currency as MXN", async () => {
  const proposal = manifest({ totalMinor: R.PLACEHOLDER });
  for (const [name, w, m] of [["proposal, listing USD", world({ listing: { currencyCode: "USD" } }), proposal],
    ["proposal, currency missing", world({ listing: { currencyCode: undefined } }), proposal],
    ["proposal, listing unreadable", world({ listing: { id: 603566 }, }), proposal],
    ["bound, listing USD", world({ listing: { currencyCode: "USD" } }), manifest()]]) {
    if (name === "proposal, listing unreadable") {
      const inner = w.fetchImpl;
      w.fetchImpl = async (u, init) => (new URL(String(u)).pathname === "/v1/listings/603566" ? new Response("{}", { status: 503 }) : inner(u, init));
    }
    const { r } = await cli(PRE, { w, m });
    assert.deepEqual([r.exitCode, r.output.price, r.output.checks.price], [EXIT.INCOMPLETE, { code: "PRICE_CURRENCY_UNPROVEN" }, false], name);
    assert.ok(!JSON.stringify(r.output.price).includes("MXN") && !("observedTotalMinor" in r.output.price), name);
  }
});

test("Airbnb link evidence: only the documented airbnbListingUrl, parsed structurally; unrelated text never qualifies", async () => {
  const ev = (v) => P.airbnbLinkEvidence(v === undefined ? {} : { airbnbListingUrl: v });
  for (const ok of ["https://www.airbnb.com/rooms/1798070853315176756", "https://airbnb.com/rooms/1798070853315176756/"]) assert.equal(ev(ok), "AIRBNB_URL_MATCHES", ok);
  assert.equal(ev("https://www.airbnb.com/rooms/1798047712926775907"), "AIRBNB_URL_OTHER_ID");
  assert.equal(ev("https://www.airbnb.com/rooms/1798070853315176757"), "AIRBNB_URL_OTHER_ID", "string compare: no precision loss");
  for (const v of [undefined, null, ""]) assert.equal(ev(v), "AIRBNB_URL_ABSENT_UNKNOWN");
  for (const bad of [1798070853315176756, "not a url", "http://www.airbnb.com/rooms/1798070853315176756", "https://www.airbnb.com.evil.example/rooms/1798070853315176756",
    "https://evil.example/rooms/1798070853315176756", "https://user:pw@www.airbnb.com/rooms/1798070853315176756", "https://www.airbnb.com:8443/rooms/1798070853315176756",
    "https://www.airbnb.com/rooms/1798070853315176756?source_impression_id=x", "https://www.airbnb.com/rooms/1798070853315176756#x",
    "https://www.airbnb.com/rooms/plus/1798070853315176756", "https://www.airbnb.com/rooms/01798070853315176756", "https://www.airbnb.com/s/1798070853315176756"]) {
    assert.equal(ev(bad), "AIRBNB_URL_INVALID_UNKNOWN", String(bad));
  }
  // root's regression: the id in unrelated text (and no link) is NOT mapping evidence
  let { r } = await cli(PRE, { w: world({ listing: { airbnbListingUrl: null, internalNote: "See 1798070853315176756", channelListing: "https://www.airbnb.com/rooms/1798070853315176756" } }) });
  assert.equal(r.output.listing.mapping, "AIRBNB_URL_ABSENT_UNKNOWN");
  // another id in the documented link is an explicit contradiction: reported, exit 3
  ({ r } = await cli(PRE, { w: world({ listing: { airbnbListingUrl: "https://www.airbnb.com/rooms/1798047712926775907" } }) }));
  assert.deepEqual([r.exitCode, r.output.listing.mapping, r.output.checks.mappingNotContradicted], [EXIT.INCOMPLETE, "AIRBNB_URL_OTHER_ID", false]);
});

test("token refused: only the token was fetched; everything uncertain; sanitized diagnostic; exit 3", async () => {
  const { r, w } = await cli(PRE, { w: world({ token: () => new Response(JSON.stringify({ result: "PROVIDER-TEXT" }), { status: 401 }) }) });
  assert.deepEqual(w.log, ["POST /v1/accessTokens"]);
  assert.deepEqual([r.exitCode, r.output.transportDiag, r.output.transportUsage], [EXIT.INCOMPLETE, { stage: "TOKEN", code: "TOKEN_HTTP_REFUSED", httpStatus: 401 }, { mintState: "failed", fetches: 1 }]);
  assert.deepEqual([r.output.listing.code, r.output.calendar.code, r.output.checks.price], ["LISTING_TRANSPORT_UNCERTAIN", "CALENDAR_UNKNOWN", false]);
  leakFree(r.output);
});

test("two-layer allowlist: no write kind, no booking/cancel/other listing/other shape; the fetch guard refuses before fetch", async () => {
  const c = checkPrecheckManifest(manifest(), { now: NOW, reviewedCommit: SHA });
  const st = { bound: boundShapes(c), readableIds: new Set(), cancellableId: null };
  const code = (req, wk) => { try { return assertPrecheckRequest(req, st, wk); } catch (e) { return e.code; } };
  assert.equal(code({ method: "POST", path: "/reservations", query: {}, body: {} }, "create"), "PRECHECK_WRITES_NOTHING");
  assert.equal(code({ method: "PUT", path: "/reservations/1/statuses/cancelled", query: {}, body: { cancelledBy: "host" } }, "cancel"), "PRECHECK_WRITES_NOTHING");
  for (const req of [{ method: "POST", path: "/reservations", query: {}, body: {} }, { method: "GET", path: "/listings/603564", query: {} },
    { method: "GET", path: "/listings/603566", query: { includeResources: 1 } }, { method: "POST", path: "/listings/603566/calendar/priceDetails", query: {}, body: { ...st.bound.priceBody, numberOfGuests: 1 } },
    { method: "GET", path: "/listings/603566/calendar", query: { startDate: "2027-04-01", endDate: "2027-04-30" } }, { method: "GET", path: "/reservations", query: { ...st.bound.lookup, arrivalStartDate: "2027-04-06" } },
    { method: "GET", path: "/reservations/70636076", query: { includeResources: 1 } }, { method: "GET", path: "/conversations", query: {} }]) {
    assert.equal(code(req, null), "REQUEST_NOT_ALLOWLISTED", JSON.stringify(req));
  }
  let inner = 0;
  const g = guardFetch(async () => { inner++; return new Response("{}"); }, st.bound);
  const go = async (u, init = {}) => { try { await g.guarded(u, init); return "SENT"; } catch (e) { return e.name; } };
  const B = "https://api.hostaway.com/v1";
  for (const [u, init] of [[`${B}/reservations`, { method: "POST", body: "{}" }], [`${B}/reservations/1/statuses/cancelled`, { method: "PUT", body: "{}" }],
    [`${B}/listings/603564`, {}], [`${B}/listings/603566?x=1`, {}], [`${B}/listings/603566/calendar/priceDetails`, { method: "POST", body: JSON.stringify({ ...st.bound.priceBody, version: 1 }) }],
    [`${B}/listings/603566/calendar?startDate=2027-04-01&endDate=2027-04-30`, {}], ["https://evil.example/v1/accessTokens", { method: "POST", body: "x" }]]) {
    assert.equal(await go(u, init), "LocalRefusal", `${init.method ?? "GET"} ${u}`);
  }
  assert.equal(inner, 0);
  assert.equal(await go(`${B}/listings/603566`), "SENT");
  assert.equal(await go(`${B}/listings/603566`), "LocalRefusal", "second listing read refused");
  assert.equal(await go(`${B}/listings/603566/calendar/priceDetails`, { method: "POST", body: JSON.stringify(st.bound.priceBody) }), "SENT");
  assert.deepEqual(g.used(), { token: 0, listing: 1, price: 1, calendar: 0, lookup: 0, refused: 8 });
});

test("operator Airbnb prompt: no TTY => UNKNOWN; a TTY answer is read and normalized", async () => {
  assert.equal(await askAirbnbOnTty({ input: { isTTY: false }, output: { write() {} } })({ airbnbListingId: "1", nights: [] }), "UNKNOWN");
  const listeners = [];
  const input = { isTTY: true, on: (e, f) => listeners.push(f), removeListener() {}, pause() {}, resume() {} };
  let printed = "";
  const p = askAirbnbOnTty({ input, output: { write: (s) => { printed += s; } } })({ airbnbListingId: C.CONNECTED_AIRBNB_LISTING_ID, nights: ["2027-04-05", "2027-04-06"] });
  listeners[0](" open\n");
  assert.equal(await p, "OPEN");
  assert.ok(printed.includes("https://www.airbnb.com/rooms/1798070853315176756") && !/source_impression_id|\?/.test(printed.split("rooms/")[1].split(" ")[0]));
});

test("containment and provenance metadata: read-only CLI (no file writes), main guarded, closure == CONNECTED_PRECHECK_SOURCES, nothing imports it", () => {
  const src = readFileSync(join(ROOT, "scripts/e4-connected/connected-precheck.mjs"), "utf8");
  for (const re of [/writeFileSync|appendFileSync|createWriteStream|mkdirSync|renameSync|unlink|rmSync|createFileJournal/, /process\.env/, /console\./,
    /executeConnectedRun|buildCreateReservationRequest|statuses\/cancelled/]) assert.doesNotMatch(src, re, String(re));
  assert.match(src, /if \(process\.argv\[1\] && resolve\(process\.argv\[1\]\) === fileURLToPath\(import\.meta\.url\)\)/);
  const seen = new Set();
  const walk = (f) => {
    if (seen.has(f)) return; seen.add(f);
    for (const m of readFileSync(join(ROOT, f), "utf8").matchAll(/(?:^|\n)\s*(?:import|export)\s[^;]*?from\s+["']([^"']+)["']/g)) {
      if (m[1].startsWith(".")) walk(relative(ROOT, resolve(dirname(join(ROOT, f)), m[1])).replace(/\\/g, "/"));
      else assert.match(m[1], /^node:(crypto|fs|path|url|child_process)$/, `external import ${m[1]} in ${f}`);
    }
  };
  walk("scripts/e4-connected/connected-precheck.mjs");
  assert.deepEqual([...seen].sort(), [...CONNECTED_PRECHECK_SOURCES].sort());
  const files = (p) => readdirSync(join(ROOT, p), { withFileTypes: true }).flatMap((e) => e.isDirectory() ? (e.name === "node_modules" ? [] : files(join(p, e.name))) : [join(p, e.name)]);
  const importers = [...files("api"), ...files("lib"), ...files("scripts")].filter((f) => /(from\s*|import\s*\(\s*)["'][^"']*connected-precheck/.test(readFileSync(join(ROOT, f), "utf8")));
  assert.deepEqual(importers, []);
  assert.equal(C.CONNECTED_EXECUTION_WIRED, false);
});
