// scripts/e7-connected/e7-create-credential-file.mjs — create an EMPTY credential file with TRUE exclusive 0600 creation
// (O_CREAT | O_EXCL | O_WRONLY | O_NOFOLLOW) and NO truncation. Fails if the path already exists or is a symlink. Prints a status code
// only — never a secret. The operator then pastes the secret into the file with an editor (which preserves the mode); the secret never
// touches a shell command line or history. Linux/darwin only (the credential reader's supported platforms).
import { openSync, closeSync, constants as C } from "node:fs";
import { pathToFileURL } from "node:url";
import process from "node:process";

export const CREATE_FLAGS = C.O_CREAT | C.O_EXCL | C.O_WRONLY | C.O_NOFOLLOW;

/** createExclusive0600(path, { open, close }) → { ok, code }. Pure wrapper over the open flags; no truncation; no follow of a final symlink. */
export function createExclusive0600(path, { open = openSync, close = closeSync } = {}) {
  if (typeof path !== "string" || path.length < 2 || path[0] !== "/" || path.includes("\0")) return { ok: false, code: "PATH_INVALID" };
  let fd;
  try { fd = open(path, CREATE_FLAGS, 0o600); }
  catch (e) {
    const c = e && e.code;
    if (c === "EEXIST") return { ok: false, code: "EXISTS" };          // a regular file (or anything) already at the path — not truncated
    if (c === "ELOOP") return { ok: false, code: "SYMLINK" };          // final component is a symlink; O_NOFOLLOW refused to follow it
    return { ok: false, code: "CREATE_FAILED" };
  }
  try { close(fd); } catch { /* best effort; the file is already created empty with mode 0600 */ }
  return { ok: true, code: "CREATED" };
}

async function main() {
  if (process.platform !== "linux" && process.platform !== "darwin") {
    process.stdout.write(JSON.stringify({ schema: "e7-cred-create-v1", code: "PLATFORM_UNSUPPORTED" }) + "\n"); process.exit(3);
  }
  const path = process.argv[2];
  const r = createExclusive0600(path);
  process.stdout.write(JSON.stringify({ schema: "e7-cred-create-v1", code: r.code }) + "\n");
  process.exit(r.ok ? 0 : (r.code === "EXISTS" || r.code === "SYMLINK" ? 4 : 2));
}
if (process.argv[1]) { try { if (import.meta.url === pathToFileURL(process.argv[1]).href) main(); } catch { /* not a direct run */ } }
