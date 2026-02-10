const ALLOWED_ORIGINS = new Set([
  "http://127.0.0.1:5500",
  "http://localhost:5500"
]);

function applyCors(req, res) {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function parseDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return null;
  }

  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }

  return date;
}

function addDays(date, days) {
  const next = new Date(date.getTime());
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function formatDate(date) {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export default async function handler(req, res) {
  try {
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");

    if (req.method === "OPTIONS") {
      applyCors(req, res);
      res.status(204).end();
      return;
    }

    if (req.method !== "GET") {
      applyCors(req, res);
      res.status(405).json({ error: "Method Not Allowed" });
      return;
    }

    const { apartmentId, checkIn, checkOut, guests, debug } = req.query;
    console.log("availability query", { apartmentId, checkIn, checkOut, guests });

    if (!apartmentId || !checkIn || !checkOut || !guests) {
      const payload = { available: false, nightlyPrice: null };
      if (debug === "1") {
        payload._debug = {
          reason: "missing_params",
          got: { apartmentId, checkIn, checkOut, guests }
        };
      }
      applyCors(req, res);
      res.status(200).json(payload);
      return;
    }

    const checkInDate = parseDate(checkIn);
    const checkOutDate = parseDate(checkOut);
    if (!checkInDate || !checkOutDate) {
      const payload = { available: false, nightlyPrice: null };
      if (debug === "1") {
        payload._debug = {
          reason: "missing_params",
          got: { apartmentId, checkIn, checkOut, guests }
        };
      }
      applyCors(req, res);
      res.status(200).json(payload);
      return;
    }

    if (checkOutDate <= checkInDate) {
      const payload = { available: false, nightlyPrice: null };
      if (debug === "1") {
        payload._debug = {
          reason: "invalid_date_range",
          got: { checkIn, checkOut }
        };
      }
      applyCors(req, res);
      res.status(200).json(payload);
      return;
    }

    const apiKey = process.env.SMOOBU_API_KEY;
    if (!apiKey) {
      const payload = { available: false, nightlyPrice: null };
      if (debug === "1") {
        payload._debug = { reason: "missing_api_key" };
      }
      applyCors(req, res);
      res.status(200).json(payload);
      return;
    }

    const startDate = formatDate(checkInDate);
    const endDate = formatDate(addDays(checkOutDate, -1));
    const upstreamUrl = `https://login.smoobu.com/api/rates?start_date=${encodeURIComponent(startDate)}&end_date=${encodeURIComponent(endDate)}&apartments%5B%5D=${encodeURIComponent(String(apartmentId))}`;

    const response = await fetch(upstreamUrl, {
      headers: {
        "Api-Key": apiKey,
        "Accept": "application/json"
      }
    });

    const upstreamStatus = response.status;
    const upstreamStatusText = response.statusText;
    const upstreamText = await response.text();
    if (!response.ok) {
      applyCors(req, res);
      res.status(502).json({
        ok: false,
        error: "SMOOBU_UPSTREAM_FAILED",
        upstream: {
          status: Number.isFinite(upstreamStatus) ? upstreamStatus : null,
          statusText: typeof upstreamStatusText === "string" ? upstreamStatusText : null
        }
      });
      return;
    }

    let upstreamJson = null;
    try {
      upstreamJson = upstreamText ? JSON.parse(upstreamText) : null;
    } catch (parseError) {
      applyCors(req, res);
      res.status(502).json({
        ok: false,
        error: "SMOOBU_UPSTREAM_INVALID",
        upstream: {
          status: Number.isFinite(upstreamStatus) ? upstreamStatus : null,
          statusText: typeof upstreamStatusText === "string" ? upstreamStatusText : null
        }
      });
      return;
    }

    const prices =
      (upstreamJson && upstreamJson.data && upstreamJson.data[String(apartmentId)]) ||
      (upstreamJson && upstreamJson.data && upstreamJson.data[apartmentId]) ||
      null;

    if (!prices) {
      const payload = { available: false, nightlyPrice: null };
      if (debug === "1") {
        payload._debug = {
          upstreamUrl,
          upstreamStatus,
          nights: [],
          failedNight: null,
          failedReason: "missing_prices_object",
          priceKeysSample: []
        };
      }
      applyCors(req, res);
      res.status(200).json(payload);
      return;
    }

    const nights = [];
    for (let cursor = checkInDate; cursor < checkOutDate; cursor = addDays(cursor, 1)) {
      nights.push(formatDate(cursor));
    }

    let available = true;
    let failedNight = null;
    let failedReason = null;
    let failedAvailable = null;

    for (const night of nights) {
      const entry = prices[night];
      if (!entry) {
        available = false;
        failedNight = night;
        failedReason = "missing_price_entry";
        break;
      }
      if (entry.available !== 1) {
        available = false;
        failedNight = night;
        failedReason = "night_unavailable";
        failedAvailable = entry.available;
        break;
      }
      if (!Number.isFinite(entry.price)) {
        available = false;
        failedNight = night;
        failedReason = "missing_price_value";
        break;
      }
    }

    const nightlyPrice = available && nights.length > 0 && prices[nights[0]]
      ? Number(prices[nights[0]].price)
      : null;

    const payload = { available, nightlyPrice };

    if (debug === "1") {
      payload._debug = {
        upstreamUrl,
        upstreamStatus,
        requestedStartDate: startDate,
        requestedEndDate: endDate,
        nights,
        failedNight,
        failedReason,
        failedAvailable,
        priceKeysSample: Object.keys(prices).slice(0, 5)
      };
    }

    applyCors(req, res);
    res.status(200).json(payload);
  } catch (err) {
    console.error("[smoobu] endpoint failed", {
      endpoint: "availability",
      message: err?.message,
      stack: err?.stack
    });
    try {
      applyCors(req, res);
    } catch (corsError) {
      // Ignore secondary failures when applying CORS headers.
    }
    res.status(500).json({
      ok: false,
      error: "FUNCTION_FAILED",
      endpoint: "availability",
      message: err?.message || "Unknown error"
    });
  }
}
