import { pool } from "./_db.js";

// --- Utility: CORS Handling ---
function setCorsHeaders(res, methods = "GET,POST,OPTIONS") {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", methods);
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

// --- Utility: Path Parsing ---
function getPathSegments(req) {
  // Remove /api/ prefix and split
  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname.replace(/^\/api\//, "");
  return path.split("/").filter(Boolean);
}

// --- Health Handler ---
function handleHealth(req, res) {
  setCorsHeaders(res, "GET,OPTIONS");
  if (req.method === "OPTIONS") {
    res.status(200).end();
    return;
  }
  res.status(200).json({ ok: true, ts: new Date().toISOString() });
}

// --- Holds Router ---
async function handleHolds(req, res, pathSegments) {
  setCorsHeaders(res);
  if (req.method === "OPTIONS") {
    res.status(200).end();
    return;
  }
  // Support both ?action= and /holds/active etc
  const url = new URL(req.url, `http://${req.headers.host}`);
  const action = url.searchParams.get("action") || pathSegments[1];
  switch (action) {
    case "active":
      await handleHoldsActive(req, res);
      break;
    case "create":
      await handleHoldsCreate(req, res);
      break;
    case "release":
      await handleHoldsRelease(req, res);
      break;
    case "confirm":
      await handleHoldsConfirm(req, res);
      break;
    case "dbcheck":
      await handleHoldsDbcheck(req, res);
      break;
    case "ping":
      handleHoldsPing(req, res);
      break;
    case "test-insert":
      await handleHoldsTestInsert(req, res);
      break;
    default:
      // Default: /api/holds or unknown action
      if (!action && req.method === "GET") {
        await handleHoldsActive(req, res);
      } else {
        res.status(400).json({ ok: false, error: "UNKNOWN_ACTION", action });
      }
      break;
  }
}

// --- Smoobu Router ---
async function handleSmoobu(req, res, pathSegments) {
  setCorsHeaders(res);
  if (req.method === "OPTIONS") {
    res.status(200).end();
    return;
  }
  const sub = pathSegments[1];
  switch (sub) {
    case "apartments":
      await handleSmoobuApartments(req, res);
      break;
    case "availability":
      await handleSmoobuAvailability(req, res);
      break;
    case "me":
      await handleSmoobuMe(req, res);
      break;
    case "quote":
      await handleSmoobuQuote(req, res);
      break;
    case "test":
      await handleSmoobuTest(req, res);
      break;
    default:
      res.status(404).json({ ok: false, error: "UNKNOWN_SMOOBU_ROUTE", route: sub });
      break;
  }
}

// --- Internal Holds Handlers ---
async function handleHoldsActive(req, res) { /* ...existing code... */ }
async function handleHoldsCreate(req, res) { /* ...existing code... */ }
async function handleHoldsRelease(req, res) { /* ...existing code... */ }
async function handleHoldsConfirm(req, res) { /* ...existing code... */ }
async function handleHoldsDbcheck(req, res) { /* ...existing code... */ }
function handleHoldsPing(req, res) { /* ...existing code... */ }
async function handleHoldsTestInsert(req, res) { /* ...existing code... */ }

// --- Internal Smoobu Handlers ---
async function handleSmoobuApartments(req, res) { /* ...existing code... */ }
async function handleSmoobuAvailability(req, res) { /* ...existing code... */ }
async function handleSmoobuMe(req, res) { /* ...existing code... */ }
async function handleSmoobuQuote(req, res) { /* ...existing code... */ }
async function handleSmoobuTest(req, res) { /* ...existing code... */ }

// --- Main Handler ---
export default async function handler(req, res) {
  const pathSegments = getPathSegments(req);
  const root = pathSegments[0];
  switch (root) {
    case "health":
      handleHealth(req, res);
      break;
    case "holds":
      await handleHolds(req, res, pathSegments);
      break;
    case "smoobu":
      await handleSmoobu(req, res, pathSegments);
      break;
    default:
      res.status(404).json({ ok: false, error: "UNKNOWN_API_ROUTE", route: root });
      break;
  }
}
