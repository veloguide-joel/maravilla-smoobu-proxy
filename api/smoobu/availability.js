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
  if (!apartmentId || !checkIn || !checkOut) {
    applyCors(req, res);
    res.status(400).json({ error: "Missing required parameters" });
    return;
  }

  const checkInDate = parseDate(checkIn);
  const checkOutDate = parseDate(checkOut);
  if (!checkInDate || !checkOutDate) {
    applyCors(req, res);
    res.status(400).json({ error: "Invalid date format" });
    return;
  }

  if (checkOutDate <= checkInDate) {
    applyCors(req, res);
    res.status(400).json({ error: "checkOut must be after checkIn" });
    return;
  }

  const apiKey = process.env.SMOOBU_API_KEY;
  if (!apiKey) {
    applyCors(req, res);
    res.status(500).json({ error: "Missing SMOOBU_API_KEY" });
    return;
  }

  const endDate = addDays(checkOutDate, -1);
  const params = new URLSearchParams();
  params.set("start_date", formatDate(checkInDate));
  params.set("end_date", formatDate(endDate));
  params.append("apartments[]", String(apartmentId));
  const upstreamUrl = `https://login.smoobu.com/api/rates?${params.toString()}`;

  try {
    const response = await fetch(upstreamUrl, {
      headers: {
        "Api-Key": apiKey,
        "Accept": "application/json"
      }
    });

    const upstreamStatus = response.status;
    const upstreamText = await response.text();

    if (!response.ok) {
      applyCors(req, res);
      res.status(upstreamStatus).json({
        error: "Upstream Smoobu error",
        upstreamStatus,
        upstreamBody: upstreamText
      });
      return;
    }

    let data;
    try {
      data = upstreamText ? JSON.parse(upstreamText) : null;
    } catch (parseError) {
      applyCors(req, res);
      res.status(500).json({ error: "Failed to parse upstream response" });
      return;
    }

    const nights = [];
    for (let cursor = checkInDate; cursor <= endDate; cursor = addDays(cursor, 1)) {
      nights.push(formatDate(cursor));
    }

    const parsedNights = [];
    const missingAvailabilityDates = [];
    const prices = data && data.prices ? data.prices : null;
    let allAvailableByFlag = true;
    let allPricesPresent = true;
    let totalPrice = 0;
    let firstNightPrice = null;

    for (const night of nights) {
      const dayInfo = prices ? prices[night] : null;
      const availabilityValue = dayInfo ? dayInfo.available : null;
      const priceValue = dayInfo ? dayInfo.price : null;

      parsedNights.push({
        date: night,
        available: availabilityValue,
        price: priceValue
      });

      let nightOk = true;
      if (!dayInfo) {
        nightOk = false;
        missingAvailabilityDates.push(night);
      } else if (availabilityValue === 0) {
        nightOk = false;
      } else if (availabilityValue == null && priceValue == null) {
        nightOk = false;
      }

      allAvailableByFlag = allAvailableByFlag && nightOk;

      if (priceValue == null) {
        allPricesPresent = false;
      } else {
        totalPrice += Number(priceValue);
      }

      if (firstNightPrice == null && night === nights[0]) {
        firstNightPrice = priceValue == null ? null : Number(priceValue);
      }
    }

    const available = allAvailableByFlag && missingAvailabilityDates.length === 0;
    let nightlyPrice = null;

    if (available && allPricesPresent) {
      const average = nights.length ? totalPrice / nights.length : 0;
      nightlyPrice = Number(average.toFixed(2));
    } else if (available && firstNightPrice != null) {
      nightlyPrice = Number(firstNightPrice.toFixed(2));
    }

    const payload = { available, nightlyPrice };

    if (debug === "1") {
      payload._debug = {
        upstreamUrl,
        upstreamStatus,
        upstreamBody: data,
        parsedFields: {
          nights: parsedNights,
          conflictsCount: null,
          missingAvailabilityDates: missingAvailabilityDates.length
            ? missingAvailabilityDates
            : null,
          allPricesPresent
        }
      };
    }

    applyCors(req, res);
    res.status(200).json(payload);
  } catch (err) {
    applyCors(req, res);
    res.status(500).json({ error: err.message });
  }
}
