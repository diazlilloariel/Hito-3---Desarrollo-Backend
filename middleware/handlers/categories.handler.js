import { pool } from "../../consultas.js";
import { setShortCacheHeaders } from "../../cache/productsCache.js";

export async function listCategories(_req, res, next) {
  try {
    const r = await pool.query(
      `SELECT id, name FROM categories ORDER BY name ASC`,
    );
    setShortCacheHeaders(res);
    return res.json(r.rows);
  } catch (e) {
    next(e);
  }
}
