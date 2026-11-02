// test/helpers/import-closure.mjs — APPROXIMATE static ESM import tracer (read-only; no bundler is installed).
// Follows `import … from "x"`, `export … from "x"`, side-effect `import "x"` and LITERAL dynamic `import("x")`.
// A non-literal dynamic import anywhere in a traced file is reported (it could reach anything). This approximates what a
// platform file tracer should include; it is NOT proof of what Vercel bundles or loads (see the platform validation gate).
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname, relative } from "node:path";

const STATIC = [/^\s*import\s+(?:[^'";]*?\sfrom\s+)?["']([^"']+)["']/gm, /^\s*export\s+[^'";]*?\sfrom\s+["']([^"']+)["']/gm];
const DYN_LITERAL = /\bimport\(\s*["']([^"']+)["']\s*\)/g;
const DYN_ANY = /\bimport\(/g;
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/([^:"'`])\/\/[^\n"'`]*$/gm, "$1");

/** closure(root, entry) -> { files: Map(relPath -> "static"|"dynamic"), packages: Set, nonLiteralDynamic: [relPath] } */
export function importClosure(root, entry) {
  const files = new Map(); const packages = new Set(); const nonLiteralDynamic = [];
  const stack = [[resolve(root, entry), "static"]];
  while (stack.length) {
    const [abs, how] = stack.pop();
    const rel = relative(root, abs).split("\\").join("/");
    if (files.has(rel)) { if (how === "static") files.set(rel, "static"); continue; }
    files.set(rel, how);
    const src = stripComments(readFileSync(abs, "utf8"));
    const add = (spec, kind) => {
      if (spec.startsWith(".")) {
        const t = resolve(dirname(abs), spec);
        if (!existsSync(t)) throw new Error(`unresolved ${spec} from ${rel}`);
        stack.push([t, kind]);
      } else packages.add(spec);
    };
    for (const re of STATIC) for (const m of src.matchAll(re)) add(m[1], how);
    const lit = [...src.matchAll(DYN_LITERAL)];
    for (const m of lit) add(m[1], "dynamic");
    if ([...src.matchAll(DYN_ANY)].length !== lit.length) nonLiteralDynamic.push(rel);
  }
  return { files, packages, nonLiteralDynamic };
}
