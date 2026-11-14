// scripts/e7-resend/resend-exchange.mjs — C42: the ONE network primitive of the Resend SYNTHETIC sink-send probe. NEW, self-contained,
// node built-ins only (no SDK, no fetch, no dependency); the frozen accepted real-exchange / http-transports are NOT edited or reused.
//
// createResendExchange({ https?, timers?, budgets? }) → { ok:true, exchange } | { ok:false, code }. INERT on import and on creation: no socket, no
// Agent, no timer until the single exchange() call. exchange({ method, host, path, headers, body }) performs AT MOST ONE request, ever:
//   * fixed route ONLY: POST https://api.resend.com:443/emails (anything else → EXCHANGE_INPUT_INVALID before any socket);
//   * strict TLS: rejectUnauthorized true, servername api.resend.com, minVersion TLSv1.2, system CAs (no custom CA, no proxy agent);
//   * a dedicated Agent { keepAlive:false, maxSockets:1 } destroyed on EVERY exit path; the request and response are destroyed too;
//   * ONE total deadline (default 10 000 ms) via AbortController + one timer, cleared on every path; the caller cannot extend it;
//   * redirects are NEVER followed (node:https does not follow; a 3xx is returned as a status for the caller to refuse);
//   * no decompression: Accept-Encoding must be 'identity' and any non-identity Content-Encoding is refused before the body is read;
//   * finite streamed body: Content-Length > maxBytes (default 65 536) refused before reading; the stream is cut at maxBytes + 1;
//   * the response must COMPLETE (res.complete) — a premature close is EXCHANGE_PREMATURE_CLOSE;
//   * the instance is SPENT after the first call (a second call → EXCHANGE_SPENT, no socket): no retry of any kind exists here.
// Errors carry a CODE only (the message is the code); the underlying error, the request headers (Authorization) and the body are never put
// into an error, return value or log. The resolved value exposes only status, three allowlisted response headers and the raw body bytes.
import nodeHttps from "node:https";

const freeze = Object.freeze;
export const RESEND_HOST = "api.resend.com";
export const RESEND_PORT = 443;
export const RESEND_PATH = "/emails";
export const RESEND_METHOD = "POST";
export const EXCHANGE_BUDGETS = freeze({ maxBytes: 65536, deadlineMs: 10000, attempts: 1 });
export const EXCHANGE_CODES = freeze(["EXCHANGE_OPTIONS_INVALID", "EXCHANGE_INPUT_INVALID", "EXCHANGE_SPENT", "EXCHANGE_SETUP_FAILED", "EXCHANGE_DEADLINE",
  "EXCHANGE_NETWORK_ERROR", "EXCHANGE_PREMATURE_CLOSE", "EXCHANGE_STATUS_INVALID", "EXCHANGE_ENCODING_REFUSED", "EXCHANGE_BODY_TOO_LARGE"]);

const fail = (code) => Object.assign(new Error(code), { code });
const isObj = (o) => o !== null && typeof o === "object" && !Array.isArray(o);
const HEADER_NAME_RE = /^[A-Za-z][A-Za-z0-9-]{0,63}$/;
const HEADER_VALUE_RE = /^[\x20-\x7E]{1,600}$/;            // printable ASCII only: no CR / LF / NUL (no header injection)

/** first value of an incoming header, as a string or null */
const hv = (h, k) => { const v = h?.[k]; return typeof v === "string" ? v : Array.isArray(v) && typeof v[0] === "string" ? v[0] : null; };

export function createResendExchange({ https = nodeHttps, timers = globalThis, budgets = EXCHANGE_BUDGETS } = {}) {
  if (!https || typeof https.request !== "function" || typeof https.Agent !== "function" || !timers || typeof timers.setTimeout !== "function" || typeof timers.clearTimeout !== "function"
      || !isObj(budgets) || !Number.isSafeInteger(budgets.maxBytes) || budgets.maxBytes < 1 || budgets.maxBytes > EXCHANGE_BUDGETS.maxBytes
      || !Number.isSafeInteger(budgets.deadlineMs) || budgets.deadlineMs < 1 || budgets.deadlineMs > EXCHANGE_BUDGETS.deadlineMs || budgets.attempts !== 1) {
    return freeze({ ok: false, code: "EXCHANGE_OPTIONS_INVALID" });
  }
  let spent = false;
  async function exchange(input) {
    if (spent) throw fail("EXCHANGE_SPENT");
    spent = true;                                                    // spent BEFORE any validation or socket: one call per instance, ever
    if (!isObj(input) || input.method !== RESEND_METHOD || input.host !== RESEND_HOST || input.path !== RESEND_PATH || !(input.body instanceof Uint8Array)
        || input.body.length < 2 || !isObj(input.headers)) throw fail("EXCHANGE_INPUT_INVALID");
    const headers = {};
    for (const [k, v] of Object.entries(input.headers)) {
      if (!HEADER_NAME_RE.test(k) || typeof v !== "string" || !HEADER_VALUE_RE.test(v)) throw fail("EXCHANGE_INPUT_INVALID");
      headers[k] = v;
    }
    if (headers["Accept-Encoding"] !== "identity" || headers["Content-Length"] !== String(input.body.length)) throw fail("EXCHANGE_INPUT_INVALID");
    const body = Buffer.from(input.body);
    const { maxBytes, deadlineMs } = budgets;
    return await new Promise((resolve, reject) => {
      let agent = null, req = null, res = null, timer = null, settled = false;
      const ac = new AbortController();
      const teardown = () => {
        if (timer !== null) { timers.clearTimeout(timer); timer = null; }
        try { res?.destroy?.(); } catch { /* ignore */ }
        try { req?.destroy?.(); } catch { /* ignore */ }
        try { agent?.destroy?.(); } catch { /* ignore */ }
      };
      const done = (err, value) => { if (settled) return; settled = true; teardown(); if (err) reject(fail(err)); else resolve(value); };
      try {
        timer = timers.setTimeout(() => { ac.abort(); done("EXCHANGE_DEADLINE"); }, deadlineMs);
        agent = new https.Agent({ keepAlive: false, maxSockets: 1 });
        req = https.request({ protocol: "https:", hostname: RESEND_HOST, port: RESEND_PORT, method: RESEND_METHOD, path: RESEND_PATH, headers, agent,
          servername: RESEND_HOST, rejectUnauthorized: true, minVersion: "TLSv1.2", signal: ac.signal }, (r) => {
          res = r;
          if (settled) return;
          const status = r.statusCode;
          if (!Number.isSafeInteger(status) || status < 100 || status > 599) return done("EXCHANGE_STATUS_INVALID");
          const enc = hv(r.headers, "content-encoding");
          if (enc !== null && enc.trim().toLowerCase() !== "identity") return done("EXCHANGE_ENCODING_REFUSED");
          const cl = hv(r.headers, "content-length");
          if (cl !== null && (!/^\d{1,12}$/.test(cl) || Number(cl) > maxBytes)) return done("EXCHANGE_BODY_TOO_LARGE");
          const chunks = []; let n = 0;
          r.on("data", (c) => {
            if (settled) return;
            n += c.length;
            if (n > maxBytes) return done("EXCHANGE_BODY_TOO_LARGE");
            chunks.push(Buffer.from(c));
          });
          r.on("aborted", () => done("EXCHANGE_PREMATURE_CLOSE"));
          r.on("error", () => done("EXCHANGE_NETWORK_ERROR"));
          r.on("close", () => { if (!settled) done("EXCHANGE_PREMATURE_CLOSE"); });
          r.on("end", () => {
            if (settled) return;
            if (r.complete !== true) return done("EXCHANGE_PREMATURE_CLOSE");
            done(null, freeze({ status, headers: freeze({ contentType: hv(r.headers, "content-type"), contentEncoding: enc, idempotentReplayed: hv(r.headers, "idempotent-replayed") }),
              body: Buffer.concat(chunks) }));
          });
        });
        req.on("error", () => done(ac.signal.aborted ? "EXCHANGE_DEADLINE" : "EXCHANGE_NETWORK_ERROR"));
        req.end(body);
      } catch {
        done("EXCHANGE_SETUP_FAILED");
      }
    });
  }
  return freeze({ ok: true, exchange });
}
