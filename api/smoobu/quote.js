import { pool } from "../_db.js";

// Thunder Client example:
// GET http://localhost:3000/api/smoobu/quote?apartmentId=123&arrival=2026-03-01&departure=2026-03-05&adults=2&children=0&currency=MXN

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

function dateMinusOneDay(date) {
  return formatDate(addDays(date, -1));
}

function normalizeQuery(query) {
  const arrival = query?.arrival ?? query?.start_date ?? query?.from ?? null;
  const departure = query?.departure ?? query?.end_date ?? query?.to ?? null;
  const apartmentId = query?.apartmentId ?? null;
  const debug = query?.debug === "1";

  const missing = [];
  const invalid = {};

  if (!apartmentId) {
    missing.push("apartmentId");
  }

  if (!arrival) {
    missing.push("arrival");
  }

  if (!departure) {
    missing.push("departure");
  }

  const apartmentIdNumber = Number(apartmentId);
  if (apartmentId && !Number.isFinite(apartmentIdNumber)) {
    invalid.apartmentId = "INVALID_NUMBER";
  }

  const arrivalDate = arrival ? parseDate(String(arrival)) : null;
  const departureDate = departure ? parseDate(String(departure)) : null;

  if (arrival && !arrivalDate) {
    invalid.arrival = "INVALID_DATE";
  }

  if (departure && !departureDate) {
    invalid.departure = "INVALID_DATE";
  }

  if (arrivalDate && departureDate && departureDate <= arrivalDate) {
    invalid.dateRange = "DEPARTURE_NOT_AFTER_ARRIVAL";
  }

  const hasErrors = missing.length > 0 || Object.keys(invalid).length > 0;
  if (hasErrors) {
    return { ok: false, debug };
  }

  return {
    ok: true,
    values: {
      apartmentId: String(apartmentId),
      apartmentIdNumber,
      arrival: String(arrival),
      departure: String(departure),
      arrivalDate,
      departureDate,
      debug
    }
  };
}

async function callSmoobuAvailability({ apiKey, arrival, departure, apartmentIdNumber, customerId }) {
  const url = "https://login.smoobu.com/booking/checkApartmentAvailability";
  const payload = {
    arrivalDate: arrival,
    departureDate: departure,
    apartments: [apartmentIdNumber],
    customerId
  };

  let response = null;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "Api-Key": apiKey,
        "Content-Type": "application/json",
        "Accept": "application/json"
      },
      body: JSON.stringify(payload)
    });
  } catch (err) {
    return {
      ok: false,
      request: { url, method: "POST" },
      upstream: { status: null, statusText: null }
    };
  }

  const upstreamStatus = response.status;
  const upstreamStatusText = response.statusText;
  if (!response.ok) {
    return {
      ok: false,
      request: { url, method: "POST" },
      upstream: {
        status: Number.isFinite(upstreamStatus) ? upstreamStatus : null,
        statusText: typeof upstreamStatusText === "string" ? upstreamStatusText : null
      }
    };
  }

  let json = null;
  try {
    json = await response.json();
  } catch (err) {
    return {
      ok: false,
      request: { url, method: "POST" },
      upstream: {
        status: Number.isFinite(upstreamStatus) ? upstreamStatus : null,
        statusText: typeof upstreamStatusText === "string" ? upstreamStatusText : null
      }
    };
  }

  const availableApartments = Array.isArray(json?.availableApartments)
    ? json.availableApartments
    : null;

  if (!availableApartments) {
    return {
      ok: false,
      request: { url, method: "POST" },
      upstream: {
        status: Number.isFinite(upstreamStatus) ? upstreamStatus : null,
        statusText: typeof upstreamStatusText === "string" ? upstreamStatusText : null
      }
    };
  }

  const normalizedAvailable = availableApartments
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value));

  return {
    ok: true,
    available: normalizedAvailable.includes(apartmentIdNumber),
    upstreamStatus,
    upstreamStatusText,
    availableApartmentsCount: availableApartments.length,
    requestUrl: url
  };
}

async function callSmoobuRates({ apiKey, arrival, endDateForRates, apartmentId }) {
  const url = `https://login.smoobu.com/api/rates?start_date=${encodeURIComponent(arrival)}&end_date=${encodeURIComponent(endDateForRates)}&apartments%5B%5D=${encodeURIComponent(String(apartmentId))}`;

  let response = null;
  try {
    response = await fetch(url, {
      headers: {
        "Api-Key": apiKey,
        "Accept": "application/json"
      }
    });
  } catch (err) {
    return {
      ok: false,
      request: { url, method: "GET" },
      upstream: { status: null, statusText: null }
    };
  }

  const upstreamStatus = response.status;
  const upstreamStatusText = response.statusText;
  if (!response.ok) {
    return {
      ok: false,
      request: { url, method: "GET" },
      upstream: {
        status: Number.isFinite(upstreamStatus) ? upstreamStatus : null,
        statusText: typeof upstreamStatusText === "string" ? upstreamStatusText : null
      }
    };
  }

  let json = null;
  try {
    json = await response.json();
  } catch (err) {
    return {
      ok: false,
      request: { url, method: "GET" },
      upstream: {
        status: Number.isFinite(upstreamStatus) ? upstreamStatus : null,
        statusText: typeof upstreamStatusText === "string" ? upstreamStatusText : null
      }
    };
  }

  const prices =
    (json && json.data && json.data[String(apartmentId)]) ||
    (json && json.data && json.data[apartmentId]) ||
    null;

  return {
    ok: true,
    prices: prices && typeof prices === "object" ? prices : null,
    upstreamStatus,
    upstreamStatusText,
    requestUrl: url
  };
}

function getNightDates(arrivalDate, departureDate) {
  const nights = [];
  for (let cursor = arrivalDate; cursor < departureDate; cursor = addDays(cursor, 1)) {
    nights.push(formatDate(cursor));
  }
  return nights;
}

function computePrices(prices, nights) {
  if (!prices || !Array.isArray(nights) || nights.length === 0) {
    return { nightlyPrice: null, totalPrice: null, pricedNightsCount: 0 };
  }

  let total = 0;
  let count = 0;

  for (const night of nights) {
    const entry = prices[night];
    if (!entry || !Number.isFinite(entry.price)) {
      continue;
    }
    total += Number(entry.price);
    count += 1;
  }

  if (count === 0) {
    return { nightlyPrice: null, totalPrice: null, pricedNightsCount: 0 };
  }

  return {
    nightlyPrice: total / count,
    totalPrice: total,
    pricedNightsCount: count
  };
}

export default async function handler(req, res) {
  try {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

    if (req.method === "OPTIONS") {
      res.status(200).end();
      return;
    }

    if (req.method !== "GET") {
      res.status(405).json({ ok: false, error: "METHOD_NOT_ALLOWED" });
      return;
    }

    const normalized = normalizeQuery(req.query || {});
    if (!normalized.ok) {
      res.status(400).json({
        ok: false,
        error: "VALIDATION_ERROR"
      });
      return;
    }

    const {
      apartmentId,
      apartmentIdNumber,
      arrival,
      departure,
      arrivalDate,
      departureDate,
      debug
    } = normalized.values;

    const conflictResult = await pool.query(
      "SELECT " +
        "SUM(CASE WHEN status = 'hold' AND hold_expires_at > now() THEN 1 ELSE 0 END) AS holds, " +
        "SUM(CASE WHEN status IN ('confirmed','paid','booked') THEN 1 ELSE 0 END) AS reservations " +
        "FROM booking_intents " +
        "WHERE unit_id = $1 " +
        "AND (" +
        "(status = 'hold' AND hold_expires_at > now()) " +
        "OR status IN ('confirmed','paid','booked')" +
        ") " +
        "AND $2::date < check_out AND $3::date > check_in",
      [apartmentId, arrival, departure]
    );

    const holds = Number(conflictResult.rows[0]?.holds || 0);
    const reservations = Number(conflictResult.rows[0]?.reservations || 0);

    if (holds > 0 || reservations > 0) {
      res.status(409).json({
        ok: false,
        available: false,
        reason: "DATE_CONFLICT",
        conflicts: { holds, reservations }
      });
      return;
    }

    const apiKey = process.env.SMOOBU_API_KEY;
    if (!apiKey) {
      res.status(500).json({ ok: false, error: "SMOOBU_KEY_MISSING" });
      return;
    }

    const customerId = Number(process.env.SMOOBU_CUSTOMER_ID);
    if (!Number.isFinite(customerId)) {
      res.status(500).json({ ok: false, error: "SMOOBU_CUSTOMER_ID_MISSING" });
      return;
    }

    const availabilityResult = await callSmoobuAvailability({
      apiKey,
      arrival,
      departure,
      apartmentIdNumber,
      customerId
    });

    if (!availabilityResult.ok) {
      res.status(502).json({
        ok: false,
        error: "SMOOBU_UPSTREAM_FAILED",
        upstream: availabilityResult.upstream
      });
      return;
    }

    if (!availabilityResult.available) {
      const debugInfo = debug
        ? {
            arrival,
            departure,
            end_date_for_rates: dateMinusOneDay(departureDate),
            customerId,
            upstreamStatusAvailability: Number.isFinite(availabilityResult.upstreamStatus)
              ? availabilityResult.upstreamStatus
              : null,
            upstreamStatusRates: null,
            ratesCount: null
          }
        : undefined;

      res.status(200).json({
        ok: true,
        source: "smoobu",
        available: false,
        ...(debugInfo ? { debug: debugInfo } : {})
      });
      return;
    }

    const endDateForRates = dateMinusOneDay(departureDate);
    const ratesResult = await callSmoobuRates({
      apiKey,
      arrival,
      endDateForRates,
      apartmentId: apartmentIdNumber
    });

    if (!ratesResult.ok) {
      res.status(502).json({
        ok: false,
        error: "SMOOBU_UPSTREAM_FAILED",
        upstream: ratesResult.upstream
      });
      return;
    }

    const nights = getNightDates(arrivalDate, departureDate);
    const ratesEntries = ratesResult.prices && typeof ratesResult.prices === "object"
      ? Object.entries(ratesResult.prices)
      : [];
    const ratesCount = ratesEntries.length;
    const sampleEntry = ratesEntries.length > 0 ? ratesEntries[0][1] : null;
    const nightlyFieldCandidates = sampleEntry && typeof sampleEntry === "object"
      ? Object.keys(sampleEntry)
      : [];
    const ratesSample = ratesEntries.slice(0, 2).map(([date, entry]) => ({
      date,
      price: Number.isFinite(entry?.price) ? Number(entry.price) : null,
      available: entry?.available ?? null
    }));

    if (!ratesResult.prices || ratesCount === 0) {
      const debugInfo = debug
        ? {
            arrival,
            departure,
            end_date_for_rates: endDateForRates,
            customerId,
            upstreamStatusAvailability: Number.isFinite(availabilityResult.upstreamStatus)
              ? availabilityResult.upstreamStatus
              : null,
            upstreamStatusRates: Number.isFinite(ratesResult.upstreamStatus)
              ? ratesResult.upstreamStatus
              : null,
            ratesCount,
            ratesSample,
            nightlyFieldCandidates
          }
        : undefined;

      res.status(200).json({
        ok: true,
        source: "smoobu",
        available: true,
        priced: false,
        message: "AVAILABLE_BUT_NO_RATES",
        ...(debugInfo ? { debug: debugInfo } : {})
      });
      return;
    }

    const { totalPrice } = computePrices(ratesResult.prices, nights);
    const subtotal = totalPrice ?? 0;

    const debugInfo = debug
      ? {
          arrival,
          departure,
          end_date_for_rates: endDateForRates,
          customerId,
          upstreamStatusAvailability: Number.isFinite(availabilityResult.upstreamStatus)
            ? availabilityResult.upstreamStatus
            : null,
          upstreamStatusRates: Number.isFinite(ratesResult.upstreamStatus)
            ? ratesResult.upstreamStatus
            : null,
          ratesCount,
          ratesSample,
          nightlyFieldCandidates
        }
      : undefined;

    res.status(200).json({
      ok: true,
      source: "smoobu",
      available: true,
      priced: true,
      apartmentId,
      arrival,
      departure,
      nights: nights.length,
      currency: "MXN",
      quote: {
        subtotal,
        taxes: null,
        fees: null,
        total: subtotal
      },
      ...(debugInfo ? { debug: debugInfo } : {})
    });
  } catch (err) {
    console.error("[smoobu] endpoint failed", {
      endpoint: "quote",
      message: err?.message,
      stack: err?.stack
    });
    res.status(500).json({
      ok: false,
      error: "FUNCTION_FAILED",
      endpoint: "quote",
      message: err?.message || "Unknown error"
    });
  }
}
