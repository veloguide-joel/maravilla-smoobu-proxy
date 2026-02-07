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

  const { apartmentId, checkIn, checkOut } = req.query;
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

  try {
    const response = await fetch(
      `https://login.smoobu.com/api/rates?${params.toString()}`,
      {
        headers: {
          "Api-Key": apiKey,
          "Accept": "application/json"
        }
      }
    );

    if (!response.ok) {
      const detail = (await response.text()).slice(0, 500);
      applyCors(req, res);
      res.status(response.status).json({
        error: "Smoobu API error",
        status: response.status,
        detail
      });
      return;
    }

    const data = await response.json();

    const nights = [];
    for (let cursor = checkInDate; cursor <= endDate; cursor = addDays(cursor, 1)) {
      nights.push(formatDate(cursor));
    }

    let totalPrice = 0;
    for (const night of nights) {
      const dayInfo = (data && data[night]) || (data && data.data && data.data[night]);
      if (!dayInfo || dayInfo.available !== 1 || dayInfo.price == null) {
        applyCors(req, res);
        res.status(200).json({ available: false, nightlyPrice: null });
        return;
      }
      totalPrice += Number(dayInfo.price);
    }

    const average = nights.length ? totalPrice / nights.length : 0;
    applyCors(req, res);
    res.status(200).json({
      available: true,
      nightlyPrice: Number(average.toFixed(2))
    });
  } catch (err) {
    applyCors(req, res);
    res.status(500).json({ error: err.message });
  }
}
