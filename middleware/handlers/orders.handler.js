import { pool } from "../../consultas.js";
import { invalidateProductsCache, setShortCacheHeaders } from "../../cache/productsCache.js";
import {
  AUTO_CANCEL_TTL_MINUTES,
  autoCancelExpiredOnlineOrders,
} from "../../jobs/autoCancelExpiredOnlineOrders.js";

function toDeliveryType(modeOrDeliveryType) {
  const v = String(modeOrDeliveryType ?? "").toLowerCase();
  return v === "delivery" ? "delivery" : "pickup";
}

function toPaymentMethod(method) {
  const v = String(method ?? "").toLowerCase();
  if (v === "in_store") return "in_store";
  if (v === "online") return "online";
  return "online";
}

export async function createOrder(req, res, next) {
  try {
    const {
      id,
      mode,
      delivery_type,
      payment_method,
      address_id,
      phone,
      address,
      notes,
      items,
    } = req.body ?? {};

    const orderId = id ? String(id) : `FX-${Date.now()}`;
    const deliveryType = toDeliveryType(delivery_type ?? mode);
    const paymentMethod = toPaymentMethod(payment_method ?? "online");

    if (!deliveryType || !paymentMethod || !Array.isArray(items) || !items.length) {
      return res.status(400).json({ message: "Payload inválido" });
    }

    const expiresAt =
      paymentMethod === "online"
        ? new Date(Date.now() + AUTO_CANCEL_TTL_MINUTES * 60 * 1000)
        : null;

    const addressId = deliveryType === "delivery" ? (address_id ?? null) : null;

    // merge qty by productId
    const mapQty = new Map();
    for (const it of items) {
      const productId = String(it?.productId ?? it?.id ?? "");
      const qty = Number(it?.qty ?? 0);
      if (!productId || !Number.isInteger(qty) || qty <= 0) {
        return res.status(400).json({ message: "Items inválidos" });
      }
      mapQty.set(productId, (mapQty.get(productId) ?? 0) + qty);
    }
    const mergedItems = Array.from(mapQty.entries()).map(([productId, qty]) => ({ productId, qty }));
    const ids = mergedItems.map((x) => x.productId);

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      const pr = await client.query(
        `
        SELECT
          p.id,
          p.name,
          p.price,
          i.stock_on_hand,
          i.stock_reserved,
          (i.stock_on_hand - i.stock_reserved) AS stock_available
        FROM products p
        JOIN inventory i ON i.product_id = p.id
        WHERE p.id = ANY($1::text[]) AND p.active = TRUE
        FOR UPDATE OF i
        `,
        [ids],
      );

      const byId = new Map(pr.rows.map((p) => [p.id, p]));
      if (pr.rows.length !== ids.length) {
        await client.query("ROLLBACK");
        return res.status(400).json({ message: "Producto inexistente o inactivo" });
      }

      let subtotal = 0;

      for (const it of mergedItems) {
        const p = byId.get(it.productId);
        if (!p) {
          await client.query("ROLLBACK");
          return res.status(400).json({ message: `Producto inválido: ${it.productId}` });
        }
        if (Number(p.stock_available) < it.qty) {
          await client.query("ROLLBACK");
          return res.status(409).json({
            message: `Stock insuficiente: ${p.id}`,
            productId: p.id,
            available: Number(p.stock_available),
            requested: it.qty,
          });
        }
        subtotal += Number(p.price) * it.qty;
      }

      const shippingCost = 0;
      const total = subtotal + shippingCost;

      await client.query(
        `
        INSERT INTO orders (
          id, user_id, delivery_type, payment_method, status, address_id,
          subtotal, shipping_cost, total, expires_at
        )
        VALUES ($1,$2,$3,$4,'pending_payment',$5,$6,$7,$8,$9)
        `,
        [
          orderId,
          req.user.id,
          deliveryType,
          paymentMethod,
          addressId,
          subtotal,
          shippingCost,
          total,
          expiresAt,
        ],
      );

      for (const it of mergedItems) {
        const p = byId.get(it.productId);
        const qty = Number(it.qty);
        const lineTotal = Number(p.price) * qty;

        await client.query(
          `
          INSERT INTO order_items (order_id, product_id, qty, unit_price, line_total)
          VALUES ($1,$2,$3,$4,$5)
          `,
          [orderId, p.id, qty, p.price, lineTotal],
        );

        await client.query(
          `UPDATE inventory SET stock_reserved = stock_reserved + $1 WHERE product_id = $2`,
          [qty, p.id],
        );

        await client.query(
          `
          INSERT INTO stock_movements (product_id, order_id, user_id, movement_type, qty, note)
          VALUES ($1,$2,$3,'reserve',$4,$5)
          `,
          [
            p.id,
            orderId,
            req.user.id,
            qty,
            notes ? String(notes).trim() : "Reserva por orden pending_payment",
          ],
        );
      }

      await client.query(
        `
        INSERT INTO payments (order_id, provider, status, amount, transaction_id)
        VALUES ($1,'webpay','initiated',$2,$3)
        ON CONFLICT (order_id) DO NOTHING
        `,
        [orderId, total, `TX-${Date.now()}`],
      );

      await client.query("COMMIT");
      invalidateProductsCache();

      return res.status(201).json({
        message: "Orden creada",
        orderId,
        status: "pending_payment",
        delivery_type: deliveryType,
        payment_method: paymentMethod,
        expires_at: expiresAt,
        total,
        phone: phone ?? null,
        address: address ?? null,
      });
    } catch (e) {
      try { await client.query("ROLLBACK"); } catch {}
      return res.status(500).json({ message: "Error creando orden" });
    } finally {
      client.release();
    }
  } catch (e) {
    next(e);
  }
}

export async function myOrders(req, res, next) {
  try {
    const r = await pool.query(
      `
      SELECT
        o.id,
        o.delivery_type,
        o.payment_method,
        o.status,
        o.subtotal,
        o.shipping_cost,
        o.total,
        o.created_at,
        o.updated_at,
        o.expires_at
      FROM orders o
      WHERE o.user_id = $1
      ORDER BY o.created_at DESC
      `,
      [req.user.id],
    );
    return res.json(r.rows);
  } catch (e) {
    next(e);
  }
}

export async function ordersMeta(_req, res, next) {
  try {
    const r = await pool.query(`
      SELECT COALESCE(MAX(updated_at), NOW()) AS last_changed
      FROM orders
    `);
    setShortCacheHeaders(res);
    return res.json({ lastChanged: r.rows[0].last_changed });
  } catch (e) {
    next(e);
  }
}

export async function listOrders(req, res, next) {
  try {
    const { status, deliveryType, q, limit, offset } = req.query;

    const filters = [];
    const values = [];

    if (status) {
      values.push(String(status).trim().toLowerCase());
      filters.push(`o.status = $${values.length}`);
    }

    if (deliveryType) {
      values.push(String(deliveryType).trim().toLowerCase());
      filters.push(`o.delivery_type = $${values.length}`);
    }

    if (q) {
      values.push(`%${String(q).toLowerCase()}%`);
      filters.push(
        `(LOWER(o.id) LIKE $${values.length} OR LOWER(u.email) LIKE $${values.length})`,
      );
    }

    const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";

    const lim = Math.min(Math.max(Number(limit ?? 50), 1), 200);
    const off = Math.max(Number(offset ?? 0), 0);

    values.push(lim);
    const limIdx = values.length;
    values.push(off);
    const offIdx = values.length;

    const sql = `
      SELECT
        o.id,
        o.status,
        o.delivery_type,
        o.payment_method,
        o.subtotal,
        o.shipping_cost,
        o.total,
        o.created_at,
        o.updated_at,
        o.expires_at,

        json_build_object(
          'id', u.id,
          'name', u.name,
          'email', u.email
        ) AS customer,

        COALESCE(
          json_agg(
            json_build_object(
              'productId', oi.product_id,
              'name', p.name,
              'qty', oi.qty,
              'unitPrice', oi.unit_price,
              'lineTotal', oi.line_total
            )
            ORDER BY oi.product_id
          ) FILTER (WHERE oi.product_id IS NOT NULL),
          '[]'::json
        ) AS items

      FROM orders o
      JOIN users u ON u.id = o.user_id
      LEFT JOIN order_items oi ON oi.order_id = o.id
      LEFT JOIN products p ON p.id = oi.product_id

      ${where}
      GROUP BY o.id, u.id
      ORDER BY o.created_at DESC
      LIMIT $${limIdx} OFFSET $${offIdx}
    `;

    const r = await pool.query(sql, values);
    setShortCacheHeaders(res);
    return res.json(r.rows);
  } catch (e) {
    next(e);
  }
}

export async function getOrderById(req, res, next) {
  try {
    const { id } = req.params;

    const r = await pool.query(
      `
      SELECT
        o.id,
        o.status,
        o.delivery_type,
        o.payment_method,
        o.subtotal,
        o.shipping_cost,
        o.total,
        o.created_at,
        o.updated_at,
        o.expires_at,

        json_build_object(
          'id', u.id,
          'name', u.name,
          'email', u.email
        ) AS customer,

        COALESCE(
          json_agg(
            json_build_object(
              'productId', oi.product_id,
              'name', p.name,
              'qty', oi.qty,
              'unitPrice', oi.unit_price,
              'lineTotal', oi.line_total
            )
            ORDER BY oi.product_id
          ) FILTER (WHERE oi.product_id IS NOT NULL),
          '[]'::json
        ) AS items

      FROM orders o
      JOIN users u ON u.id = o.user_id
      LEFT JOIN order_items oi ON oi.order_id = o.id
      LEFT JOIN products p ON p.id = oi.product_id
      WHERE o.id = $1
      GROUP BY o.id, u.id
      `,
      [id],
    );

    if (!r.rows.length) return res.status(404).json({ message: "Orden no encontrada" });

    setShortCacheHeaders(res);
    return res.json(r.rows[0]);
  } catch (e) {
    next(e);
  }
}

export async function updateOrderStatus(req, res, next) {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    const raw = req.body?.status;

    if (!raw) return res.status(400).json({ message: "Status inválido" });

    let status = String(raw).trim().toLowerCase();

    if (
      status === "en despacho" ||
      status === "en_despacho" ||
      status === "en-despacho" ||
      status === "despachada" ||
      status === "despachado"
    ) {
      status = "shipped";
    }

    const allowed = [
      "pending_payment",
      "paid",
      "preparing",
      "ready_for_pickup",
      "shipped",
      "delivered",
      "cancelled",
    ];
    if (!allowed.includes(status)) {
      return res.status(400).json({ message: "Status inválido" });
    }

    // RBAC extra: SOLO manager puede setear shipped
    if (status === "shipped" && req.user?.role !== "manager") {
      return res.status(403).json({ message: "Solo manager puede marcar En despacho." });
    }

    await client.query("BEGIN");

    const cur = await client.query(
      `SELECT id, status FROM orders WHERE id = $1 FOR UPDATE`,
      [id],
    );
    if (!cur.rows.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "Orden no encontrada" });
    }

    const prevStatus = cur.rows[0].status;

    // Guardrails
    if (status === "shipped" && prevStatus === "cancelled") {
      await client.query("ROLLBACK");
      return res.status(409).json({ message: "No puedes despachar una orden cancelada." });
    }
    if (status === "cancelled" && prevStatus === "shipped") {
      await client.query("ROLLBACK");
      return res.status(409).json({ message: "No puedes cancelar una orden ya despachada." });
    }

    const r = await client.query(
      `
      UPDATE orders
      SET status = $1,
          updated_at = NOW()
      WHERE id = $2
      RETURNING id, status
      `,
      [status, id],
    );

    // shipped: descuenta on_hand + libera reserved + movimiento out (idempotente)
    if (status === "shipped" && prevStatus !== "shipped") {
      const items = await client.query(
        `SELECT product_id, qty FROM order_items WHERE order_id = $1`,
        [id],
      );

      for (const it of items.rows) {
        const qty = Number(it.qty);

        await client.query(
          `
          UPDATE inventory
          SET stock_on_hand = GREATEST(stock_on_hand - $1, 0),
              stock_reserved = GREATEST(stock_reserved - $1, 0),
              updated_at = NOW()
          WHERE product_id = $2
          `,
          [qty, it.product_id],
        );

        await client.query(
          `
          INSERT INTO stock_movements (product_id, order_id, user_id, movement_type, qty, note)
          SELECT $1, $2, $3, 'out', $4, 'Salida por despacho (status=shipped)'
          WHERE NOT EXISTS (
            SELECT 1
            FROM stock_movements
            WHERE product_id = $1
              AND order_id = $2
              AND movement_type = 'out'
          )
          `,
          [it.product_id, id, req.user.id, qty],
        );
      }
    }

    // cancelled: libera reservas + release_reserve + void payment (idempotente)
    if (status === "cancelled" && prevStatus !== "cancelled") {
      const items = await client.query(
        `SELECT product_id, qty FROM order_items WHERE order_id = $1`,
        [id],
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
          SELECT $1,$2,$3,'release_reserve',$4,$5
          WHERE NOT EXISTS (
            SELECT 1 FROM stock_movements
            WHERE product_id = $1 AND order_id = $2 AND movement_type = 'release_reserve'
          )
          `,
          [it.product_id, id, req.user.id, qty, "Liberación por cancelación"],
        );
      }

      await client.query(
        `
        UPDATE payments
        SET status = 'voided'
        WHERE order_id = $1
          AND status = 'initiated'
        `,
        [id],
      );
    }

    await client.query("COMMIT");
    invalidateProductsCache();

    return res.json({ orderId: r.rows[0].id, status: r.rows[0].status });
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch {}
    next(e);
  } finally {
    client.release();
  }
}

export async function sweepExpiredOrders(_req, res, next) {
  try {
    const cancelled = await autoCancelExpiredOnlineOrders({ limit: 500 });
    return res.json({ ok: true, cancelled });
  } catch (e) {
    next(e);
  }
}
