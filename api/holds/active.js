import { applyCors, handleCorsPreflight } from "../_cors";
import { query } from "../_db";

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

export default async function handler(req, res) {
  try {
    if (handleCorsPreflight(req, res)) {
      return;
    }

    applyCors(req, res);

    if (req.method !== "GET") {
      res.status(405).json({ error: "Method Not Allowed" });
      return;
    }

    const { propertyId, from, to } = req.query;
    const details = { propertyId, from, to };

    if (typeof propertyId !== "string" || propertyId.trim() === "") {
      res.status(400).json({ error: "Invalid propertyId", details });
      return;
    }

    const fromDate = parseDate(from);
    const toDate = parseDate(to);
    if (!fromDate || !toDate) {
      res.status(400).json({ error: "Invalid date format", details });
      return;
    }

    if (toDate <= fromDate) {
      res.status(400).json({ error: "Invalid date range", details });
      return;
    }

    const result = await query(
      "SELECT id, property_id, check_in, check_out, hold_expires_at, status " +
        "FROM public.booking_intents " +
        "WHERE property_id = $1 " +
        "AND status IN ('HOLD_ACTIVE','CHECKOUT_CREATED','PAID') " +
        "AND hold_expires_at IS NOT NULL " +
        "AND hold_expires_at > now() " +
        "AND check_in < $3::date AND check_out > $2::date " +
        "ORDER BY hold_expires_at ASC",
      [propertyId, from, to]
    );

    res.status(200).json({ holds: result.rows || [] });
  } catch (err) {
    applyCors(req, res);
    res.status(500).json({
      error: "server_error",
      message: err?.message || String(err)
    });
  }
}
