// scripts/e7-test-arm.mjs — E7 C119 S2 (DRAFT): the TEST ARM GATE. Pure, read-only, no secret, no database, no network, no provider.
//
// WHAT IT DECIDES: whether the unattended TEST path is ARMED for THIS exact checkout. It never enables anything by itself: every runner keeps its
// own SHIPPED-CLOSED executeEnabled / dispatchEnabled constants (all FALSE), and the arm is an ADDITIONAL, earlier refusal.
//
// RELEASE DIGEST (non-circular): the manifest (scripts/e7-test-arm/manifest.json) lists the reviewed COMPONENT FRAMES by name / prefix / files —
// never a digest. The release digest is COMPUTED from the checkout:
//   release = SHA-256( canonical({ schema: "e7-test-arm-release-v1", manifest: SHA-256(manifest bytes),
//                                  components: [ { name, frame } … in manifest order ] }) )
//   frame   = the framedDigest convention of the reviewed runners: SHA-256(prefix, then per file: path NUL length NUL bytes NUL).
// No component file, and not the manifest, contains the release digest or any component frame digest, so nothing embeds its own result (acyclic).
// The ONE literal reviewed expectation of a release lives OUTSIDE every component (test/e7-cross-runner-regression.test.mjs).
// The ARM value (repository variable E7_TEST_AUTO_ARMED, set out-of-band by ROOT; never by code) is NOT an authority: it only arms when it EQUALS
// the release digest recomputed here from the exact checked-out bytes. Absent / malformed / another ref / an unreadable release / any other value
// (a stale release, a moved main, a tampered file) → NOT armed (CLOSED_NOOP).
//
// HONEST LIMITS: clearing or changing the variable does NOT stop work that is already running (a job that already passed its gates continues under
// its own fences); it stops only gates evaluated afterwards. The pipeline runner is a component of the release but is NOT gated by this module
// (its bytes are untouched in S2): an already queued or directly dispatched pipeline run is not refused by the arm (see the C119 S2 design).
import process from "node:process";
import { readFile, lstat } from "node:fs/promises";
import { appendFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const freeze = Object.freeze;
export const ARM_MANIFEST_PATH = "scripts/e7-test-arm/manifest.json";
export const MANIFEST_SCHEMA = "e7-test-arm-manifest-v1";
export const RELEASE_SCHEMA = "e7-test-arm-release-v1";
export const REQUIRED_COMPONENTS = freeze(["arm-gate", "kickoff", "booking-confirmation", "pipeline"]);
export const ARM_CODES = freeze(["ARMED", "ARM_ABSENT", "ARM_MALFORMED", "ARM_REF_NOT_MAIN", "ARM_RELEASE_UNREADABLE", "ARM_MISMATCH"]);
export const OUTSIDE_EVERY_COMPONENT = freeze([ARM_MANIFEST_PATH, "test/e7-cross-runner-regression.test.mjs", ".github/workflows/e7-cross-runner-regression.yml"]);

// ---- the release computation (LABELLED COPIES in scripts/e7-hosted-kickoff.mjs and scripts/e7-hosted-booking-confirmation.mjs; asserted equal) ----
const ARM_HEX64 = /^[0-9a-f]{64}$/;
const ARM_PATH_RE = /^(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+$/;
const ARM_PREFIX_RE = /^[a-z0-9-]{1,60}-v1\n$/;
function armCanonical(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(armCanonical).join(",")}]`;
  return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${armCanonical(v[k])}`).join(",")}}`;
}
const armSha = (b) => createHash("sha256").update(b).digest("hex");
async function armFrame(dir, files, prefix) {
  const h = createHash("sha256"); h.update(prefix); let total = 0;
  for (const rel of files) {
    const st = await lstat(`${dir}/${rel}`);
    if (!st.isFile() || st.size < 1 || st.size > 1048576) throw new Error("ARM_FILE");
    const b = await readFile(`${dir}/${rel}`); if (b.length !== st.size) throw new Error("ARM_FILE");
    total += b.length; if (total > 8388608) throw new Error("ARM_FILE");
    h.update(rel); h.update(Buffer.from([0])); h.update(String(b.length)); h.update(Buffer.from([0])); h.update(b); h.update(Buffer.from([0]));
  }
  return h.digest("hex");
}
/** armRelease(dir) → { ok: true, release, manifest, frames } | { ok: false } — the manifest is parsed STRICTLY; never throws */
export async function armRelease(dir) {
  try {
    const p = `${dir}/scripts/e7-test-arm/manifest.json`; const st = await lstat(p);
    if (!st.isFile() || st.size < 2 || st.size > 65536) return { ok: false };
    const bytes = await readFile(p); const m = JSON.parse(bytes.toString("utf8"));
    if (!m || typeof m !== "object" || Array.isArray(m) || JSON.stringify(Object.keys(m)) !== JSON.stringify(["schema", "components"]) || m.schema !== "e7-test-arm-manifest-v1") return { ok: false };
    const want = ["arm-gate", "kickoff", "booking-confirmation", "pipeline"];
    if (!Array.isArray(m.components) || m.components.length !== want.length) return { ok: false };
    const seen = new Set(); const comps = []; const frames = {};
    for (let i = 0; i < want.length; i += 1) {
      const x = m.components[i];
      if (!x || typeof x !== "object" || Array.isArray(x) || JSON.stringify(Object.keys(x)) !== JSON.stringify(["name", "prefix", "files"]) || x.name !== want[i]) return { ok: false };
      if (typeof x.prefix !== "string" || !ARM_PREFIX_RE.test(x.prefix) || !Array.isArray(x.files) || x.files.length < 1 || x.files.length > 8) return { ok: false };
      for (const f of x.files) {
        if (typeof f !== "string" || !ARM_PATH_RE.test(f) || f.split("/").some((s) => s === "." || s === "..") || seen.has(f)
            || ["scripts/e7-test-arm/manifest.json", "test/e7-cross-runner-regression.test.mjs", ".github/workflows/e7-cross-runner-regression.yml"].includes(f)) return { ok: false };
        seen.add(f);
      }
      const frame = await armFrame(dir, x.files, x.prefix);
      comps.push({ name: x.name, frame }); frames[x.name] = frame;
    }
    const manifest = armSha(bytes);
    return { ok: true, release: armSha(armCanonical({ schema: "e7-test-arm-release-v1", manifest, components: comps })), manifest, frames };
  } catch { return { ok: false }; }
}
/** armDecision({ dir, value, ref }) → frozen { armed, code, release, frames } — absent / malformed / ref / unreadable / mismatch → NOT armed */
export async function armDecision({ dir, value, ref }) {
  const no = (code, rel = null) => Object.freeze({ armed: false, code, release: rel, frames: null });
  if (value === undefined || value === null || value === "") return no("ARM_ABSENT");
  if (typeof value !== "string" || !ARM_HEX64.test(value)) return no("ARM_MALFORMED");
  if (ref !== "refs/heads/main") return no("ARM_REF_NOT_MAIN");
  const r = await armRelease(dir);
  if (!r.ok) return no("ARM_RELEASE_UNREADABLE");
  if (r.release !== value) return no("ARM_MISMATCH", r.release);
  return Object.freeze({ armed: true, code: "ARMED", release: r.release, frames: Object.freeze({ ...r.frames }) });
}
// ---- end of the labelled-copy block ---------------------------------------------------------------------------------------------------

/** the workflow ROUTING gate (`check`): outputs armed + (armed only) the two runner frames; ALWAYS exit 0 (not armed is a successful CLOSED_NOOP) */
export async function runCheck({ env, dir }) {
  const d = await armDecision({ dir, value: env.E7_TEST_ARM, ref: env.GITHUB_REF });
  const outputs = freeze({ armed: d.armed ? "true" : "false", kickoff: d.armed ? d.frames.kickoff : "", confirmation: d.armed ? d.frames["booking-confirmation"] : "" });
  const computed = await armRelease(dir);
  return freeze({ schema: "e7-test-arm-check-v1", code: d.armed ? "ARMED" : "CLOSED_NOOP", reason: d.code, computedRelease: computed.ok ? computed.release : null, outputs });
}

if (import.meta.main === true) {
  const dir = fileURLToPath(new URL("../", import.meta.url)).replace(/\/$/, "");
  const mode = process.argv[2];
  (mode === "check" ? runCheck({ env: process.env, dir }) : Promise.resolve(null)).then((r) => {
    if (!r) { process.stdout.write('{"code":"ARM_USAGE"}\n'); process.exit(2); }
    process.stdout.write(`${JSON.stringify(r)}\n`);
    const o = r.outputs; const ok = (o.armed === "true" || o.armed === "false") && (o.kickoff === "" || ARM_HEX64.test(o.kickoff)) && (o.confirmation === "" || ARM_HEX64.test(o.confirmation));
    if (typeof process.env.GITHUB_OUTPUT === "string" && process.env.GITHUB_OUTPUT.length > 0) {
      try { appendFileSync(process.env.GITHUB_OUTPUT, ok ? `armed=${o.armed}\nkickoff=${o.kickoff}\nconfirmation=${o.confirmation}\n` : "armed=false\nkickoff=\nconfirmation=\n"); } catch { /* outputs stay empty → not armed */ }
    }
    process.exit(0);
  }).catch(() => process.exit(0));
}
