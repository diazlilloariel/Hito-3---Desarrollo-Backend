import "./env.js";
import pkg from "pg";

const { Pool } = pkg;

const connectionString =
  process.env.NODE_ENV === "test"
    ? process.env.DATABASE_URL_TEST ?? process.env.DATABASE_URL
    : process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error(
    "DATABASE_URL no está definido. Revisa tu .env (DATABASE_URL=postgres://...)"
  );
}

export const pool = new Pool({
  connectionString,
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

export async function pingDB() {
  const r = await pool.query("SELECT NOW() AS now");
  return r.rows[0];
}
