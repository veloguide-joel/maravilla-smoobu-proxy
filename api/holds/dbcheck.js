import { pool } from "../_db.js";

function safeHostFromDatabaseUrl(databaseUrl) {
  if (typeof databaseUrl !== "string" || databaseUrl.length <= 20) {
    return null;
  }

  try {
    const url = new URL(databaseUrl);
    return url.hostname || null;
  } catch (err) {
    return null;
  }
}

export default async function handler(req, res) {
  try {
    const databaseUrl = process.env.DATABASE_URL;
    const hasDatabaseUrl = typeof databaseUrl === "string" && databaseUrl.length > 20;
    const databaseUrlHost = safeHostFromDatabaseUrl(databaseUrl);

    const basePayload = {
      ok: true,
      hasDatabaseUrl,
      databaseUrlHost,
      nodeVersion: process.version
    };

    try {
      const result = await pool.query("SELECT 1 as one");
      res.status(200).json({
        ...basePayload,
        db: { connected: true, one: result?.rows?.[0]?.one ?? null }
      });
    } catch (err) {
      res.status(500).json({
        ok: false,
        hasDatabaseUrl,
        error: err?.message || String(err),
        code: err?.code,
        detail: err?.detail
      });
    }
  } catch (err) {
    res.status(500).json({
      ok: false,
      hasDatabaseUrl: false,
      error: err?.message || String(err),
      code: err?.code,
      detail: err?.detail
    });
  }
}
