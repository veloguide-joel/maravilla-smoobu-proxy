// The packaging evidence tracer itself (APPROXIMATE; not a Vercel trace). Tiny graph fixtures for its known edge cases.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { importClosure } from "./helpers/import-closure.mjs";

const G = fileURLToPath(new URL("./fixtures/import-graph/", import.meta.url));
const asObj = (c) => Object.fromEntries([...c.files].sort());

test("whitespace before the parenthesis of a dynamic import is recognised: import (\"./b.js\")", () => {
  const c = importClosure(G, "ws/a.js");
  assert.deepEqual(asObj(c), { "ws/a.js": "static", "ws/b.js": "dynamic" });
  assert.deepEqual(c.nonLiteralDynamic, []);
});

test("a file first reached dynamically and later statically is upgraded, together with its static dependencies", () => {
  // entry -import-> d1 -dynamic-> x ; entry -dynamic-> x ; entry -import-> s -import-> x -import-> y
  const c = importClosure(G, "up/entry.js");
  assert.deepEqual(asObj(c), { "up/d1.js": "static", "up/entry.js": "static", "up/s.js": "static", "up/x.js": "static", "up/y.js": "static" });
  // the same x/y reached ONLY dynamically stay dynamic
  assert.deepEqual(asObj(importClosure(G, "up/d1.js")), { "up/d1.js": "static", "up/x.js": "dynamic", "up/y.js": "dynamic" });
});

test("a non-literal dynamic import is reported", () => {
  assert.deepEqual(importClosure(G, "up/nonlit.js").nonLiteralDynamic, ["up/nonlit.js"]);
});
