// filepath: api/smoobu/reservations.js
// Minimal route for /api/smoobu/reservations

export default async function handler(req, res) {
    console.log("[reservations] HANDLER HIT");
  try {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");

    if (req.method === "OPTIONS") {
      res.status(200).end();
      return;
    }

    if (req.method !== "GET") {
      res.status(405).json({ ok: false, error: "METHOD_NOT_ALLOWED" });
      return;
    }

    const rawId = req.query.apartmentId ?? req.query.apartment_id;
    const apartmentId = Number(rawId);

    if (!Number.isFinite(apartmentId) || apartmentId <= 0) {
      return res.status(400).json({
        ok: false,
        error: "VALIDATION_ERROR",
        message: "Missing or invalid apartmentId"
      });
    }

    console.log("[reservations] BEFORE SMOOBU FETCH");
    const apiKey = process.env.SMOOBU_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ ok: false, error: "SMOOBU_KEY_MISSING" });
    }

    let response;
    let rawText;
    try {
      response = await fetch("https://login.smoobu.com/api/reservations", {
        method: "GET",
        headers: {
          "Api-Key": apiKey,
          "Accept": "application/json"
        }
      });
      console.log("[reservations] FETCH STATUS:", response.status);
      rawText = await response.text();
      console.log("[reservations] RAW RESPONSE TEXT:", rawText);
    } catch (fetchErr) {
      return res.status(502).json({
        ok: false,
        error: "SMOOBU_UPSTREAM_FAILED",
        message: fetchErr?.message || String(fetchErr)
      });
    }

    let parsed;
    try {
      parsed = JSON.parse(rawText);
    } catch (parseErr) {
      return res.status(502).json({
        ok: false,
        error: "SMOOBU_UPSTREAM_PARSE_FAILED",
        message: parseErr?.message || String(parseErr),
        raw: rawText
      });
    }

    const bookings = Array.isArray(parsed?.bookings) ? parsed.bookings : [];
    const filtered = bookings.filter(
      booking => Number(booking?.apartment?.id) === apartmentId
    );
    const reservations = filtered.map(booking => ({
      arrival: booking.arrival,
      departure: booking.departure,
      isBlockedBooking: !!booking.isBlockedBooking
    }));

    return res.status(200).json({
      ok: true,
      apartmentId,
      reservations
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: "FUNCTION_FAILED",
      endpoint: "reservations",
      message: err?.message || "Unknown error"
    });
  }
}
