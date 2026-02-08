import pg from "pg";

const { Pool } = pg;

let pool;

function getPool() {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required to query the database");
  }

  if (!pool) {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
  }

  return pool;
}

export async function query(text, params) {
  try {
    const db = getPool();
    return await db.query(text, params);
  } catch (err) {
    console.error(err.message);
    throw err;
  }
}
