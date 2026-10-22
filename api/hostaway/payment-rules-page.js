// GET /api/hostaway/payment-rules-page — owner's private page for the E4 read-only payment-rule check.
//
// Static HTML only: this route makes NO provider call, reads NO secret and needs no key. Same runtime gate as the
// check route (404 unless VERCEL_ENV === "preview" AND VERCEL_GIT_COMMIT_REF === the feature branch) and Vercel SSO.
// Served from api/ (not public/) so it can never appear on another deployment: public/ stays robots.txt only (C8).
//
// The page: a password field for the existing diagnostic key, one "Run read-only check" button, and a sanitized
// result. One user-triggered same-origin GET to the fixed path with the key ONLY in the x-admin-key header; the field
// is cleared before the request is sent; no auto-run, no retry, locked after one attempt (reload to try again).
// textContent only; no storage, cookies, logging, console, URL parameters, external assets, scripts or analytics.
// CSP: default-src 'none'; the inline script/style are allowed by their SHA-256 hashes only; connect-src 'self';
// form-action 'none' (a form can never navigate/submit the key); frame-ancestors 'none'.

import { createHash } from "node:crypto";
import { paymentCheckGateOpen, hasInputs } from "./payment-rules-check.js";

export const CHECK_PATH = "/api/hostaway/payment-rules-check";

export const PAGE_STYLE = `body{font-family:system-ui,sans-serif;max-width:40rem;margin:2rem auto;padding:0 1rem;line-height:1.5;color:#111;background:#fff}
label,input,button{display:block;font-size:1rem}input{width:100%;padding:.5rem;margin:.25rem 0 1rem;box-sizing:border-box}
button{padding:.5rem 1rem}dl{display:grid;grid-template-columns:max-content 1fr;gap:.25rem 1rem}dt{font-weight:600}
.note{font-size:.9rem;color:#444}`;

export const PAGE_SCRIPT = `(function () {
  "use strict";
  var form = document.getElementById("f");
  var input = document.getElementById("k");
  var button = document.getElementById("run");
  var status = document.getElementById("status");
  var out = document.getElementById("out");
  var used = false;
  var VERDICTS = ["NO_RULES_RETURNED", "RULES_PRESENT_UNSCOPED", "UNRESOLVED"];
  var CODE = /^[A-Z_]{1,40}$/;
  function code(v) { return typeof v === "string" && CODE.test(v) ? v : "-"; }
  function num(v) { return typeof v === "number" && isFinite(v) && Math.floor(v) === v && v >= 0 && v <= 100000 ? String(v) : "-"; }
  function tri(v) { return v === true ? "yes" : v === false ? "no" : v === "unknown" ? "unknown" : "-"; }
  function set(id, text) { document.getElementById(id).textContent = text; }
  function render(httpStatus, body) {
    var b = body && typeof body === "object" ? body : {};
    set("o-http", num(httpStatus));
    set("o-verdict", VERDICTS.indexOf(b.verdict) >= 0 ? b.verdict : "NOT_AVAILABLE");
    set("o-reason", b.reason === null ? "none" : code(b.reason));
    set("o-error", code(b.error));
    set("o-provider", num(b.httpStatus));
    set("o-returned", num(b.returnedCount));
    set("o-declared", num(b.declaredCount));
    set("o-consistent", tri(b.countConsistent));
    set("o-isolation", b.isolationProven === false ? "no (this check cannot prove isolation)" : "-");
    out.hidden = false;
    status.textContent = "Done. Reload the page to run again.";
  }
  form.addEventListener("submit", function (ev) {
    ev.preventDefault();
    if (used) return;
    var key = input.value;
    if (!key) { status.textContent = "Enter the key first."; return; }
    used = true;
    input.value = "";
    input.disabled = true;
    button.disabled = true;
    status.textContent = "Running the read-only check...";
    var headers = new Headers();
    headers.set("x-admin-key", key);
    key = "";
    fetch("${CHECK_PATH}", { method: "GET", headers: headers, cache: "no-store", credentials: "same-origin",
      redirect: "error", referrerPolicy: "no-referrer" })
      .then(function (r) { return r.json().then(function (j) { render(r.status, j); }, function () { render(r.status, null); }); },
            function () { render(null, { error: "REQUEST_FAILED" }); });
  });
})();`;

const sha = (s) => `'sha256-${createHash("sha256").update(s, "utf8").digest("base64")}'`;
export const CSP = [
  "default-src 'none'", `script-src ${sha(PAGE_SCRIPT)}`, `style-src ${sha(PAGE_STYLE)}`, "connect-src 'self'",
  "img-src 'none'", "form-action 'none'", "base-uri 'none'", "frame-ancestors 'none'"
].join("; ");

export const PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<meta name="robots" content="noindex, nofollow">
<title>Payment rule check</title>
<style>${PAGE_STYLE}</style>
</head>
<body>
<main>
<h1>Read-only payment-rule check</h1>
<p>This sends one read-only request that lists the account's auto-payment rules. It creates, changes or charges nothing.
The key is sent only in a request header to this same site and is not stored by this page.</p>
<form id="f" autocomplete="off" novalidate>
<label for="k">Diagnostic key</label>
<input id="k" type="password" autocomplete="off" autocapitalize="off" spellcheck="false">
<button id="run" type="submit">Run read-only check</button>
</form>
<p id="status" role="status"></p>
<dl id="out" hidden>
<dt>Page request HTTP status</dt><dd id="o-http"></dd>
<dt>Verdict</dt><dd id="o-verdict"></dd>
<dt>Reason</dt><dd id="o-reason"></dd>
<dt>Error code</dt><dd id="o-error"></dd>
<dt>Provider HTTP status</dt><dd id="o-provider"></dd>
<dt>Rules returned</dt><dd id="o-returned"></dd>
<dt>Rules declared (count)</dt><dd id="o-declared"></dd>
<dt>Counts consistent</dt><dd id="o-consistent"></dd>
<dt>Isolation proven</dt><dd id="o-isolation"></dd>
</dl>
<p class="note">One attempt per page load. After running, close this tab. A web page cannot guarantee that the browser
erases the key from its memory. Share only the result shown above; never the key or a screenshot of it.</p>
</main>
<script>${PAGE_SCRIPT}</script>
</body>
</html>
`;

export default function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (!paymentCheckGateOpen()) { res.status(404).json({ ok: false, error: "NOT_FOUND" }); return; }
  if (req.method !== "GET") { res.setHeader("Allow", "GET"); res.status(405).json({ ok: false, error: "METHOD_NOT_ALLOWED" }); return; }
  if (hasInputs(req)) { res.status(400).json({ ok: false, error: "NO_INPUTS_ACCEPTED" }); return; } // never a key in the URL
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Content-Security-Policy", CSP);
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.status(200).send(PAGE_HTML);
}
