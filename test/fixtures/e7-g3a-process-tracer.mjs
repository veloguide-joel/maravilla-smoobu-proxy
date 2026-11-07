// TEST-ONLY preload (labelled): wraps the native `process` property descriptors of the INSPECT-only capabilities with accessors that
// return the ORIGINAL values and record ONLY the property NAME when the immediate caller frame is run-plan-cli-main.mjs (Node-internal
// reads are excluded by that caller test). No value is ever recorded or printed. One line `E7PROC <json>` on stderr at exit.
import fs from "node:fs";
const KEYS = ["platform", "versions", "execArgv", "env", "getuid"];
const seen = [];
const writeSync = fs.writeSync;
const callerIsCli = () => {
  const lines = String(new Error().stack).split("\n").slice(1).map((l) => l.trim());
  // [0] = this helper, [1] = the accessor below, [2] = the immediate caller of the property read
  const c = lines[2] || "";
  return /run-plan-cli-main\.mjs:\d+:\d+\)?$/.test(c);
};
for (const k of KEYS) {
  const d = Object.getOwnPropertyDescriptor(process, k) || Object.getOwnPropertyDescriptor(Object.getPrototypeOf(process), k);
  if (!d) continue;
  const read = "value" in d ? () => d.value : () => Reflect.apply(d.get, process, []);
  Object.defineProperty(process, k, { configurable: true, enumerable: d.enumerable, get() { if (callerIsCli()) seen.push(k); return read(); },
    ...("value" in d && d.writable ? { set(v) { d.value = v; } } : {}) });
}
process.on("exit", () => { try { writeSync(2, `E7PROC ${JSON.stringify(seen)}\n`); } catch { /* contained */ } });
