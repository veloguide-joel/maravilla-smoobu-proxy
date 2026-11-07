// TEST-ONLY preload (labelled): counts every PUBLIC fs call (sync / callback / promises) and every module resolution made AFTER this
// preload (with the first argument when it is a path / URL — Node's own ESM loader reading the ENTRY file is one such call), then prints ONE line `E7TRACE <json>` to stderr at exit. Used to prove execute / unknown modes touch no file and import nothing.
import fs from "node:fs";
import fsp from "node:fs/promises";
import { syncBuiltinESMExports, registerHooks } from "node:module";

const counts = { fs: 0, calls: [], resolved: [] };
const NAMES = ["open", "openSync", "readFile", "readFileSync", "lstat", "lstatSync", "stat", "statSync", "realpath", "realpathSync", "readdir", "readdirSync",
  "access", "accessSync", "writeFile", "writeFileSync", "mkdir", "mkdirSync", "rename", "renameSync", "unlink", "unlinkSync", "createReadStream", "createWriteStream"];
const writeSync = fs.writeSync;
for (const n of NAMES) {
  for (const [obj, label] of [[fs, "fs"], [fsp, "fsp"]]) {
    const orig = obj[n];
    if (typeof orig !== "function") continue;
    obj[n] = function traced(...a) { counts.fs += 1; counts.calls.push(`${label}.${n} ${typeof a[0] === "string" ? a[0] : a[0] instanceof URL ? a[0].href : typeof a[0]}`); return Reflect.apply(orig, this, a); };
  }
}
syncBuiltinESMExports();
registerHooks({ resolve(spec, ctx, next) { const r = next(spec, ctx); counts.resolved.push(spec); return r; } });
process.on("exit", () => { try { writeSync(2, `E7TRACE ${JSON.stringify(counts)}\n`); } catch { /* contained */ } });
