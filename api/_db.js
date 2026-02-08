import pg from "pg";

const { Pool } = pg;

let pool = null;

function getPool() {
  if (typeof process.env.DATABASE_URL !== "string" || process.env.DATABASE_URL.trim() === "") {
    throw new Error("DATABASE_URL is not set");
  }

  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false }
    });
  }

  return pool;
}

export async function query(text, params) {
  const db = getPool();
  return await db.query(text, params);
}
