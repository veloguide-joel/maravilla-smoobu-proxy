import { pool } from "../api/_db.js";

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

export async function getQuote({ apartmentId, from, to, guests, currency = "MXN" }) {
  // This is a placeholder. You should move your real quote logic here from api/smoobu/quote.js
  // For now, return a fake quote for testing
  if (!apartmentId || !from || !to) {
    return { ok: false, error: "MISSING_FIELDS" };
  }
  // Simulate a price calculation
  const nights = (parseDate(to) - parseDate(from)) / (1000 * 60 * 60 * 24);
  if (nights <= 0) return { ok: false, error: "INVALID_DATES" };
  const total = nights * 1000 * (guests || 2); // 1000 MXN per night per guest
  return { ok: true, total, currency, nights };
}
