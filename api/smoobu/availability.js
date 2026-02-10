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

function buildDebug({
  startDate,
  endDate,
  apartmentId,
  upstreamUrl,
  upstreamStatus,
  upstreamStatusText,
  rates
}) {
  const rateKeys = rates && typeof rates === "object" ? Object.keys(rates) : [];
  return {
    start_date: startDate || null,
    end_date: endDate || null,
    apartmentId: apartmentId ? String(apartmentId) : null,
    upstreamUrl: upstreamUrl || null,
    upstreamStatus: Number.isFinite(upstreamStatus) ? upstreamStatus : null,
    upstreamStatusText: typeof upstreamStatusText === "string" ? upstreamStatusText : null,
    ratesCount: rateKeys.length,
    sampleKeys: rateKeys.slice(0, 5)
  };
}

export default async function handler(req, res) {
  try {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");

    if (req.method === "OPTIONS") {
      res.status(200).end();
      return;
    }

    if (req.method !== "GET") {
      res.status(405).json({ error: "Method Not Allowed" });
      return;
    }

    const { apartmentId, checkIn, checkOut, guests } = req.query;
    console.log("availability query", { apartmentId, checkIn, checkOut, guests });

    if (!apartmentId || !checkIn || !checkOut || !guests) {
      res.status(200).json({
        ok: true,
        source: "smoobu",
        available: false,
        nightlyPrice: null,
        reason: "UNKNOWN",
        debug: buildDebug({ apartmentId })
      });
      return;
    }

    const checkInDate = parseDate(checkIn);
    const checkOutDate = parseDate(checkOut);
    if (!checkInDate || !checkOutDate) {
      res.status(200).json({
        ok: true,
        source: "smoobu",
        available: false,
        nightlyPrice: null,
        reason: "UNKNOWN",
        debug: buildDebug({ apartmentId })
      });
      return;
    }

    if (checkOutDate <= checkInDate) {
      res.status(200).json({
        ok: true,
        source: "smoobu",
        available: false,
        nightlyPrice: null,
        reason: "UNKNOWN",
        debug: buildDebug({ apartmentId })
      });
      return;
    }

    const apiKey = process.env.SMOOBU_API_KEY;
    if (!apiKey) {
      res.status(200).json({
        ok: true,
        source: "smoobu",
        available: false,
        nightlyPrice: null,
        reason: "UNKNOWN",
        debug: buildDebug({ apartmentId })
      });
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
      res.status(502).json({
        ok: false,
        error: "SMOOBU_UPSTREAM_FAILED",
        upstream: {
          status: Number.isFinite(upstreamStatus) ? upstreamStatus : null,
          statusText: typeof upstreamStatusText === "string" ? upstreamStatusText : null
        },
        available: false,
        nightlyPrice: null,
        reason: "UPSTREAM_NON_2XX",
        debug: buildDebug({
          startDate,
          endDate,
          apartmentId,
          upstreamUrl,
          upstreamStatus,
          upstreamStatusText
        })
      });
      return;
    }

    let upstreamJson = null;
    try {
      upstreamJson = upstreamText ? JSON.parse(upstreamText) : null;
    } catch (parseError) {
      res.status(502).json({
        ok: false,
        error: "SMOOBU_UPSTREAM_INVALID",
        upstream: {
          status: Number.isFinite(upstreamStatus) ? upstreamStatus : null,
          statusText: typeof upstreamStatusText === "string" ? upstreamStatusText : null
        },
        available: false,
        nightlyPrice: null,
        reason: "PARSE_ERROR",
        debug: buildDebug({
          startDate,
          endDate,
          apartmentId,
          upstreamUrl,
          upstreamStatus,
          upstreamStatusText
        })
      });
      return;
    }

    const prices =
      (upstreamJson && upstreamJson.data && upstreamJson.data[String(apartmentId)]) ||
      (upstreamJson && upstreamJson.data && upstreamJson.data[apartmentId]) ||
      null;

    if (!prices) {
      res.status(200).json({
        ok: true,
        source: "smoobu",
        available: true,
        nightlyPrice: null,
        reason: "NO_RATES",
        debug: buildDebug({
          startDate,
          endDate,
          apartmentId,
          upstreamUrl,
          upstreamStatus,
          upstreamStatusText
        })
      });
      return;
    }

    const priceKeys = Object.keys(prices);
    if (priceKeys.length === 0) {
      res.status(200).json({
        ok: true,
        source: "smoobu",
        available: true,
        nightlyPrice: null,
        reason: "RATES_EMPTY",
        debug: buildDebug({
          startDate,
          endDate,
          apartmentId,
          upstreamUrl,
          upstreamStatus,
          upstreamStatusText,
          rates: prices
        })
      });
      return;
    }

    const nights = [];
    for (let cursor = checkInDate; cursor < checkOutDate; cursor = addDays(cursor, 1)) {
      nights.push(formatDate(cursor));
    }

    let blocked = false;
    let partial = false;

    for (const night of nights) {
      const entry = prices[night];
      if (!entry) {
        partial = true;
        continue;
      }
      if (entry.available === 0 || entry.available === false) {
        blocked = true;
        break;
      }
      if (!Number.isFinite(entry.price)) {
        partial = true;
      }
    }

    if (blocked) {
      res.status(200).json({
        ok: true,
        source: "smoobu",
        available: false,
        nightlyPrice: null,
        reason: "UNKNOWN",
        debug: buildDebug({
          startDate,
          endDate,
          apartmentId,
          upstreamUrl,
          upstreamStatus,
          upstreamStatusText,
          rates: prices
        })
      });
      return;
    }

    if (partial) {
      res.status(200).json({
        ok: true,
        source: "smoobu",
        available: true,
        nightlyPrice: null,
        reason: "RATES_PARTIAL",
        debug: buildDebug({
          startDate,
          endDate,
          apartmentId,
          upstreamUrl,
          upstreamStatus,
          upstreamStatusText,
          rates: prices
        })
      });
      return;
    }

    const nightlyPrice = nights.length > 0 && prices[nights[0]]
      ? Number(prices[nights[0]].price)
      : null;

    res.status(200).json({
      ok: true,
      source: "smoobu",
      available: true,
      nightlyPrice,
      reason: "UNKNOWN",
      debug: buildDebug({
        startDate,
        endDate,
        apartmentId,
        upstreamUrl,
        upstreamStatus,
        upstreamStatusText,
        rates: prices
      })
    });
  } catch (err) {
    console.error("[smoobu] endpoint failed", {
      endpoint: "availability",
      message: err?.message,
      stack: err?.stack
    });
    res.status(500).json({
      ok: false,
      error: "FUNCTION_FAILED",
      endpoint: "availability",
      message: err?.message || "Unknown error"
    });
  }
}
