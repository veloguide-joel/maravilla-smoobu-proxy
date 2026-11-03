// test/helpers/import-closure.mjs — APPROXIMATE static ESM import tracer (read-only; no bundler is installed).
// Follows `import … from "x"`, `export … from "x"`, side-effect `import "x"` and LITERAL dynamic `import("x")` /
// `import ( "x" )`. A non-literal dynamic import anywhere in a traced file is reported (it could reach anything).
// Each file is labelled "static" if it is reachable from the entry through static edges only, else "dynamic" (reached
// only through at least one dynamic import). The graph is collected first and the labels computed afterwards, so a file
// first met through a dynamic edge and later through a static one is correctly upgraded together with its static
// dependencies. This approximates what a platform file tracer should include; it is NOT proof of what Vercel bundles
// or loads (see the platform validation gate).
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname, relative } from "node:path";

const STATIC = [/^\s*import\s+(?:[^'";]*?\sfrom\s+)?["']([^"']+)["']/gm, /^\s*import\s*["']([^"']+)["']/gm, /^\s*export\s+[^'";]*?\sfrom\s+["']([^"']+)["']/gm];
const DYN_LITERAL = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;
const DYN_ANY = /\bimport\s*\(/g;
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/([^:"'`])\/\/[^\n"'`]*$/gm, "$1");

/** importClosure(root, entry) -> { files: Map(relPath -> "static"|"dynamic"), packages: Set, nonLiteralDynamic: [relPath] } */
export function importClosure(root, entry) {
  const rel = (abs) => relative(root, abs).split("\\").join("/");
  const edges = new Map(); const packages = new Set(); const nonLiteralDynamic = [];
  const start = resolve(root, entry);
  const todo = [start];
  while (todo.length) {
    const abs = todo.pop();
    if (edges.has(abs)) continue;
    const out = []; edges.set(abs, out);
    const src = stripComments(readFileSync(abs, "utf8"));
    const add = (spec, kind) => {
      if (spec.startsWith(".")) {
        const t = resolve(dirname(abs), spec);
        if (!existsSync(t)) throw new Error(`unresolved ${spec} from ${rel(abs)}`);
        out.push([t, kind]); todo.push(t);
      } else packages.add(spec);
    };
    const seenStatic = new Set();
    for (const re of STATIC) for (const m of src.matchAll(re)) { if (!seenStatic.has(m.index)) { seenStatic.add(m.index); add(m[1], "static"); } }
    const lit = [...src.matchAll(DYN_LITERAL)];
    for (const m of lit) add(m[1], "dynamic");
    if ([...src.matchAll(DYN_ANY)].length !== lit.length) nonLiteralDynamic.push(rel(abs));
  }
  // static-reachable set: entry plus everything reachable through static edges only
  const staticSet = new Set([start]); const q = [start];
  while (q.length) for (const [t, k] of edges.get(q.pop())) if (k === "static" && !staticSet.has(t)) { staticSet.add(t); q.push(t); }
  const files = new Map([...edges.keys()].map((abs) => [rel(abs), staticSet.has(abs) ? "static" : "dynamic"]));
  return { files, packages, nonLiteralDynamic };
}
