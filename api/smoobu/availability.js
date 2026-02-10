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

    const query = req.query || {};
    const rawApartmentId =
      query.apartmentId ??
      query.apartment_id ??
      (Array.isArray(query["apartments[]"]) ? query["apartments[]"][0] : query["apartments[]"]) ??
      (Array.isArray(query.apartments) ? query.apartments[0] : query.apartments) ??
      null;
    const apartmentIdNumber = Number(rawApartmentId);

    if (!Number.isFinite(apartmentIdNumber)) {
      res.status(400).json({
        ok: false,
        error: "VALIDATION_ERROR",
        message: "Missing/invalid apartmentId"
      });
      return;
    }

    const arrivalRaw = query.arrival ?? query.from ?? query.start_date ?? null;
    const departureRaw = query.departure ?? query.to ?? query.end_date ?? null;

    if (!arrivalRaw || !departureRaw) {
      res.status(400).json({
        ok: false,
        error: "VALIDATION_ERROR",
        message: "Missing/invalid arrival/departure"
      });
      return;
    }

    const checkInDate = parseDate(String(arrivalRaw));
    const checkOutDate = parseDate(String(departureRaw));
    if (!checkInDate || !checkOutDate) {
      res.status(400).json({
        ok: false,
        error: "VALIDATION_ERROR",
        message: "Missing/invalid arrival/departure"
      });
      return;
    }

    if (checkOutDate <= checkInDate) {
      res.status(400).json({
        ok: false,
        error: "VALIDATION_ERROR",
        message: "Missing/invalid arrival/departure"
      });
      return;
    }

    const apiKey = process.env.SMOOBU_API_KEY;
    if (!apiKey) {
      res.status(500).json({
        ok: false,
        error: "SMOOBU_KEY_MISSING"
      });
      return;
    }

    const from = formatDate(checkInDate);
    const to = formatDate(checkOutDate);
    const upstreamUrl = "https://login.smoobu.com/booking/checkApartmentAvailability";
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
