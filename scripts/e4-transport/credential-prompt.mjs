// E4 — private credential entry for a FUTURE local run (OFFLINE scaffold; nothing calls this yet).
//
// promptHostawayCredentials() reads the Hostaway account id and the API secret from an interactive TERMINAL with
// echo OFF. It refuses anything that is not a TTY (no pipes, files or redirected input), so a secret is never passed
// on the command line, in environment variables, in shell history, in a file or in program output. Nothing typed is
// echoed, logged, returned in an error message or written anywhere; the values are returned only to the caller
// (intended: createHostawayTransport's getCredentials). No dependencies.
//
// Limits (stated, not hidden): a JavaScript string cannot be wiped from memory; the terminal/OS may keep its own
// buffers; the operator must type (not paste from a stored file) and close the terminal after the run.

export class CredentialPromptError extends Error {
  constructor(code) { super(code); this.name = "CredentialPromptError"; this.code = code; }
}

const ACCOUNT_RE = /^[1-9]\d{0,15}$/;
const MAX_LEN = 512;

/** Read one line from a TTY with echo off. Enter finishes, Backspace deletes, Ctrl-C/Ctrl-D aborts. */
export function readHiddenLine({ input, output, label }) {
  return new Promise((resolve, reject) => {
    if (!input || input.isTTY !== true || typeof input.setRawMode !== "function") { reject(new CredentialPromptError("TTY_REQUIRED")); return; }
    let value = "";
    let done = false;
    let esc = 0;            // 0 = normal, 1 = after ESC, 2 = inside CSI "ESC [ ... final", 3 = SS3 "ESC O x"
    const finish = (err) => {
      if (done) return;
      done = true;
      input.removeListener("data", onData);
      try { input.setRawMode(false); } catch { /* best effort */ }
      if (typeof input.pause === "function") input.pause();
      output.write("\n");
      if (err) { value = ""; reject(err); } else { const v = value; value = ""; resolve(v); }
    };
    const onData = (chunk) => {
      for (const ch of String(chunk)) {
        // Terminal escape sequences are never part of the value: bracketed paste markers (ESC[200~ / ESC[201~),
        // arrow/function keys (ESC[A, ESC[1;5C, ESCOP ...). Their printable tail used to be kept (E4 corrective).
        if (esc === 1) { esc = ch === "[" ? 2 : ch === "O" ? 3 : 0; continue; }
        if (esc === 2) { if (ch >= "@" && ch <= "~") esc = 0; continue; }
        if (esc === 3) { esc = 0; continue; }
        if (ch === "\u001b") { esc = 1; continue; }
        if (ch === "\r" || ch === "\n") return finish();
        if (ch === "\u0003" || ch === "\u0004") return finish(new CredentialPromptError("ABORTED"));
        if (ch === "\u007f" || ch === "\b") { value = value.slice(0, -1); continue; }
        if (ch < " ") continue;                       // other control characters are ignored
        if (value.length >= MAX_LEN) return finish(new CredentialPromptError("INPUT_TOO_LONG"));
        value += ch;                                   // never echoed
      }
    };
    output.write(`${label}: `);
    input.setRawMode(true);
    input.on("data", onData);
    if (typeof input.resume === "function") input.resume();
  });
}

/** -> frozen { accountId, clientSecret }. Throws CredentialPromptError (code only, never a value). */
export async function promptHostawayCredentials({ input = process.stdin, output = process.stderr } = {}) {
  const accountId = await readHiddenLine({ input, output, label: "Hostaway account ID (hidden)" });
  if (!ACCOUNT_RE.test(accountId)) throw new CredentialPromptError("ACCOUNT_ID_INVALID");
  const clientSecret = await readHiddenLine({ input, output, label: "Hostaway API secret (hidden)" });
  if (!clientSecret || /\s/.test(clientSecret)) throw new CredentialPromptError("SECRET_INVALID");
  return Object.freeze({ accountId, clientSecret });
}
