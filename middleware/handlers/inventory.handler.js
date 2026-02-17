import { pool } from "../../consultas.js";
import { invalidateProductsCache, setShortCacheHeaders } from "../../cache/productsCache.js";

export async function patchInventory(req, res, next) {
  try {
    const { productId } = req.params;
    const raw = req.body?.stock_on_hand;

    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0) {
      return res.status(400).json({ message: "stock_on_hand inválido" });
    }

    const r = await pool.query(
      `
      INSERT INTO inventory (product_id, stock_on_hand, stock_reserved, updated_at)
      VALUES ($1, $2, 0, NOW())
      ON CONFLICT (product_id)
      DO UPDATE SET stock_on_hand = EXCLUDED.stock_on_hand, updated_at = NOW()
      RETURNING product_id, stock_on_hand, stock_reserved
      `,
      [String(productId), n],
    );

    invalidateProductsCache();

    return res.json({
      message: "Inventario actualizado",
      inventory: r.rows[0],
    });
  } catch (e) {
    next(e);
  }
}

export async function listInventory(_req, res, next) {
  try {
    const r = await pool.query(`
      SELECT
        p.id,
        p.sku,
        p.name,
        p.description,
        p.price,
        p.image_url AS image,
        p.status,
        c.name AS category,

        i.stock_on_hand,
        i.stock_reserved,
        GREATEST((i.stock_on_hand - i.stock_reserved), 0) AS stock_available,

        p.updated_at AS product_updated_at,
        i.updated_at AS inventory_updated_at
      FROM products p
      JOIN categories c ON c.id = p.category_id
      JOIN inventory i ON i.product_id = p.id
      WHERE p.active = TRUE
      ORDER BY p.name ASC
    `);

    setShortCacheHeaders(res);
    return res.json(r.rows);
  } catch (e) {
    next(e);
  }
}
