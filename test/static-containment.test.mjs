// Stage C8 — Vercel static-file containment. Static output comes only from public/; internal trees are never uploaded.
// API functions under api/ are unaffected: Vercel bundles each function's lib/ imports into the function itself.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

test("vercel.json serves static files only from public/", () => {
  const cfg = JSON.parse(readFileSync(join(ROOT, "vercel.json"), "utf8"));
  assert.equal(cfg.outputDirectory, "public");
});

test("public/ holds only the robots.txt that disallows crawling", () => {
  assert.deepEqual(readdirSync(join(ROOT, "public")), ["robots.txt"]);
  assert.match(readFileSync(join(ROOT, "public", "robots.txt"), "utf8"), /^User-agent: \*\nDisallow: \/\n$/);
});

test(".vercelignore excludes internal trees and never api/ or lib/", () => {
  assert.ok(existsSync(join(ROOT, ".vercelignore")));
  const rules = readFileSync(join(ROOT, ".vercelignore"), "utf8").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  for (const p of ["/db", "/test", "/scripts"]) assert.ok(rules.includes(p), `${p} excluded`);
  for (const r of rules) assert.doesNotMatch(r, /^\/?(api|lib|public)(\/|$)|^\*|^!/, `rule ${r} must not touch api/, lib/ or public/`);
});
