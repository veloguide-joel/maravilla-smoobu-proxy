// Credential prompt: opt-in tolerance of leading blank terminators (owner report 2026-11-01: the connected precheck ended at
// the account-ID prompt with ACCOUNT_ID_INVALID before anything was typed). Synthetic TTY and FAKE values only; this is
// a reproduction of the reported signature, not Windows evidence of its cause.
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const { readHiddenLine, promptHostawayCredentials } = await import("../scripts/e4-transport/credential-prompt.mjs");
const { connectedCredentialPrompt } = await import("../scripts/e4-connected/connected-precheck.mjs");
const ROOT = new URL("..", import.meta.url).pathname;
const ID = "98765", SECRET = "FAKE-secret-DO-NOT-LEAK";

function fakeTty() {
  const input = new EventEmitter();
  input.isTTY = true; input.rawModes = [];
  input.setRawMode = (on) => { input.rawModes.push(on); }; input.resume = () => {}; input.pause = () => {};
  const written = [];
  return { input, output: { write: (s) => { written.push(String(s)); } }, written };
}
// feed chunks one event-loop turn apart (each chunk = one 'data' event; boundaries matter)
async function feed(t, chunks) { for (const c of chunks) { await new Promise((r) => setImmediate(r)); t.input.emit("data", Buffer.from(c)); } }
const settle = (p) => Promise.race([p.then((v) => ({ ok: v }), (e) => ({ err: e })), new Promise((r) => setTimeout(() => r({ pending: true }), 100))]);

test("reproduction: with the DEFAULT prompt, a pending CR/LF before typing ends the account-ID prompt as ACCOUNT_ID_INVALID (unchanged default)", async () => {
  for (const lead of ["\r\n", "\n", "\r"]) {
    const t = fakeTty();
    const p = settle(promptHostawayCredentials({ input: t.input, output: t.output }));
    await feed(t, [lead, `${ID}\r`, `${SECRET}\r`]);
    const r = await p;
    assert.equal(r.err?.code, "ACCOUNT_ID_INVALID", JSON.stringify(lead));
  }
  // and an Enter whose LF arrives as its own chunk ends the SECRET prompt empty
  const t = fakeTty();
  const p = settle(promptHostawayCredentials({ input: t.input, output: t.output }));
  await feed(t, [`${ID}\r`, "\n", `${SECRET}\r`]);
  assert.equal((await p).err?.code, "SECRET_INVALID");
});

test("tolerant prompt: leading CR/LF in any chunking is ignored; the typed values are returned exactly", async () => {
  const cases = [["\r\n", `${ID}\r`, `${SECRET}\r`], ["\n", `${ID}\r`, `${SECRET}\r`], ["\r", "\n", "\r\n", `${ID}\r`, `${SECRET}\r`],
    [`\r\n${ID}\r\n`, `${SECRET}\r\n`], [`${ID}\r`, "\n", `${SECRET}\r`], [`${ID}\r\n`, "\r\n", `${SECRET}\n`],
    ["\r\n9", "87", "65", "\r", "\n", "FAKE-", "secret-DO-NOT-LEAK", "\r"], ["\u001b[200~98765\u001b[201~\r", `${SECRET}\r`]];
  for (const chunks of cases) {
    const t = fakeTty();
    const p = settle(promptHostawayCredentials({ input: t.input, output: t.output, tolerateLeadingBlankLines: true }));
    await feed(t, chunks);
    const r = await p;
    assert.deepEqual(r.ok && { ...r.ok }, { accountId: ID, clientSecret: SECRET }, JSON.stringify(chunks));
    assert.deepEqual(t.input.rawModes, [true, false, true, false], "raw mode restored after each prompt");
    assert.equal(t.input.listenerCount("data"), 0);
    const shown = t.written.join("");
    assert.ok(!shown.includes(ID) && !shown.includes("FAKE"), "nothing typed is echoed");
  }
});

test("tolerance never weakens validation, abort or limits; errors carry codes only", async () => {
  const run = async (chunks) => { const t = fakeTty(); const p = settle(promptHostawayCredentials({ input: t.input, output: t.output, tolerateLeadingBlankLines: true })); await feed(t, chunks); return { r: await p, t }; };
  for (const [chunks, code] of [[["\r\n12a45\r"], "ACCOUNT_ID_INVALID"], [["\r\n 98765\r"], "ACCOUNT_ID_INVALID"], [["\n0\r"], "ACCOUNT_ID_INVALID"],
    [["\r\n98765\r", "\r\nFAKE secret\r"], "SECRET_INVALID"], [["\r\n\r\n\u0003"], "ABORTED"], [["\n\u0004"], "ABORTED"], [["\r\n98765\r", "\r\n\u0003"], "ABORTED"],
    [["\r\n" + "1".repeat(600)], "INPUT_TOO_LONG"]]) {
    const { r, t } = await run(chunks);
    assert.equal(r.err?.code, code, JSON.stringify(chunks).slice(0, 60));
    assert.ok(!String(r.err.message).includes("12a45") && !String(r.err.message).includes("FAKE") && !String(r.err.message).includes("98765"));
    assert.equal(t.input.rawModes.at(-1), false, "raw mode restored on failure");
  }
  // blank lines alone never submit an empty value (the prompt keeps waiting; Ctrl-C/D remain the way out)
  const { r } = await run(["\r\n", "\r", "\n", "\r\n"]);
  assert.equal(r.pending, true);
  // readHiddenLine: default still finishes an empty line; opt-in skips it
  let t = fakeTty();
  let p = readHiddenLine({ input: t.input, output: t.output, label: "x" });
  await feed(t, ["\r"]);
  assert.equal(await p, "");
  t = fakeTty();
  p = readHiddenLine({ input: t.input, output: t.output, label: "x", skipLeadingTerminators: true });
  await feed(t, ["\r\n", "abc\r"]);
  assert.equal(await p, "abc");
});

test("only the connected precheck opts in; every other launcher keeps the default prompt", async () => {
  const t = fakeTty();
  const p = settle(connectedCredentialPrompt({ input: t.input, output: t.output }));
  await feed(t, ["\r\n", `${ID}\r`, `${SECRET}\r`]);
  assert.deepEqual({ ...(await p).ok }, { accountId: ID, clientSecret: SECRET });
  const pre = readFileSync(join(ROOT, "scripts/e4-connected/connected-precheck.mjs"), "utf8");
  assert.match(pre, /creds = await \(deps\.prompt \?\? connectedCredentialPrompt\)\(\)/);
  assert.match(pre, /promptHostawayCredentials\(\{ input, output, tolerateLeadingBlankLines: true \}\)/);
  for (const f of ["scripts/e4-launcher/auth-check.mjs", "scripts/e4-launcher/happy-execute.mjs", "scripts/e4-launcher/reservation-shape-check.mjs", "scripts/e4-recovery/precheck.mjs"]) {
    const src = readFileSync(join(ROOT, f), "utf8");
    assert.match(src, /\(deps\.prompt \?\? promptHostawayCredentials\)\(\)/, f);
    assert.doesNotMatch(src, /tolerateLeadingBlankLines|skipLeadingTerminators/, f);
  }
  const prompt = readFileSync(join(ROOT, "scripts/e4-transport/credential-prompt.mjs"), "utf8");
  assert.doesNotMatch(prompt, /process\.env|console\.|writeFileSync|appendFileSync|createWriteStream/);
  assert.match(prompt, /tolerateLeadingBlankLines = false/);
});
