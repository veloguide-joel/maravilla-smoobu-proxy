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

function formatDate(date) {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
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

    const from = formatDate(checkInDate);
    const to = formatDate(checkOutDate);
    const upstreamUrl = "https://login.smoobu.com/booking/checkApartmentAvailability";
    const apartmentIdNumber = Number(apartmentId);

    const response = await fetch(upstreamUrl, {
      method: "POST",
      headers: {
        "Api-Key": apiKey,
        "Accept": "application/json",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        apartmentId: apartmentIdNumber,
        from,
        to
      })
    });

    const upstreamStatus = response.status;
    const upstreamStatusText = response.statusText;
    if (!response.ok) {
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
      upstreamJson = await response.json();
    } catch (parseError) {
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

    const available = upstreamJson?.available === true;

    res.status(200).json({
      ok: true,
      available,
      source: "smoobu",
      debug: {
        apartmentId: apartmentIdNumber,
        from,
        to,
        upstreamStatus: Number.isFinite(upstreamStatus) ? upstreamStatus : null
      }
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
