// e7-create-credential-file.test.mjs — focused refusal tests for the exclusive-0600 creation helper (R3).
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, lstatSync, symlinkSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createExclusive0600 } from "./e7-create-credential-file.mjs";

const tmp = () => mkdtempSync(join(tmpdir(), "e7cc-"));

test("creates an empty file with mode 0600", () => {
  const dir = tmp(); const p = join(dir, "report.login.json");
  try {
    const r = createExclusive0600(p);
    assert.deepEqual(r, { ok: true, code: "CREATED" });
    const st = lstatSync(p);
    assert.equal(st.mode & 0o777, 0o600);
    assert.equal(st.size, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("refuses an existing file WITHOUT truncating it", () => {
  const dir = tmp(); const p = join(dir, "report.login.json");
  try {
    writeFileSync(p, "PRE-EXISTING CONTENT", { mode: 0o600 });
    const r = createExclusive0600(p);
    assert.deepEqual(r, { ok: false, code: "EXISTS" });
    assert.equal(readFileSync(p, "utf8"), "PRE-EXISTING CONTENT");          // not truncated
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("refuses a symlink at the path and does not write through it", () => {
  const dir = tmp(); const target = join(dir, "target"); const link = join(dir, "link.json");
  try {
    writeFileSync(target, "TARGET CONTENT", { mode: 0o600 });
    symlinkSync(target, link);
    const r = createExclusive0600(link);
    assert.equal(r.ok, false);
    assert.ok(r.code === "SYMLINK" || r.code === "EXISTS", `got ${r.code}`);  // O_NOFOLLOW → ELOOP(SYMLINK); some libc surface EEXIST
    assert.equal(readFileSync(target, "utf8"), "TARGET CONTENT");             // target untouched
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("refuses a non-absolute / empty / NUL path", () => {
  for (const p of ["", "relative/path", "a", "/has\0nul"]) assert.equal(createExclusive0600(p).ok, false, JSON.stringify(p));
});
