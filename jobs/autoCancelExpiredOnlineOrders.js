/* =========================
   ✅ Auto-cancel config for expired online payment orders
========================= */
import { pool } from "../consultas.js";
import { invalidateProductsCache } from "../cache/productsCache.js";

export const AUTO_CANCEL_EVERY_MS = 30_000; // cada 30s
export const AUTO_CANCEL_TTL_MINUTES = 15;

export async function autoCancelExpiredOnlineOrders({ limit = 200 } = {}) {
  const r = await pool.query(
    `
    SELECT id
    FROM orders
    WHERE status = 'pending_payment'
      AND payment_method = 'online'
      AND expires_at IS NOT NULL
      AND expires_at <= NOW()
    ORDER BY expires_at ASC
    LIMIT $1
    `,
    [limit],
  );

  let cancelled = 0;

  for (const row of r.rows) {
    const orderId = row.id;
    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      const upd = await client.query(
        `
        UPDATE orders
        SET status = 'cancelled',
            updated_at = NOW()
        WHERE id = $1
          AND status = 'pending_payment'
          AND payment_method = 'online'
          AND expires_at IS NOT NULL
          AND expires_at <= NOW()
        RETURNING id, user_id
        `,
        [orderId],
      );

      if (!upd.rows.length) {
        await client.query("ROLLBACK");
        continue;
      }

      const userId = upd.rows[0].user_id;

      const items = await client.query(
        `SELECT product_id, qty FROM order_items WHERE order_id = $1`,
        [orderId],
      );

      for (const it of items.rows) {
        const qty = Number(it.qty);

        await client.query(
          `
          UPDATE inventory
          SET stock_reserved = GREATEST(stock_reserved - $1, 0),
              updated_at = NOW()
          WHERE product_id = $2
          `,
          [qty, it.product_id],
        );

        await client.query(
          `
          INSERT INTO stock_movements (product_id, order_id, user_id, movement_type, qty, note)
          SELECT $1, $2, $3, 'release_reserve', $4, 'Auto-cancel: pago online expirado (expires_at)'
          WHERE NOT EXISTS (
            SELECT 1
            FROM stock_movements
            WHERE product_id = $1
              AND order_id = $2
              AND movement_type = 'release_reserve'
          )
          `,
          [it.product_id, orderId, userId, qty],
        );
      }

      await client.query(
        `
        UPDATE payments
        SET status = 'voided'
        WHERE order_id = $1
          AND status = 'initiated'
        `,
        [orderId],
      );

      await client.query("COMMIT");
      cancelled += 1;

      invalidateProductsCache();
    } catch (e) {
      try {
        await client.query("ROLLBACK");
      } catch {}
      console.error("[autoCancelExpiredOnlineOrders]", orderId, e);
    } finally {
      client.release();
    }
  }

  return cancelled;
}

export function startAutoCancelJob() {
  return setInterval(() => {
    autoCancelExpiredOnlineOrders({ limit: 200 }).catch((e) =>
      console.error("[autoCancelExpiredOnlineOrders tick]", e),
    );
  }, AUTO_CANCEL_EVERY_MS);
}
