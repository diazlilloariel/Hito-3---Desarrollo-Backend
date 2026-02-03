// handlers/orders.handler.js
import { pool } from "../consultas.js";

function genOrderId() {
  return `FX-${Date.now()}`;
}

export async function createOrderHandler(req, res, next) {
  const client = await pool.connect();
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ message: "No autenticado" });

    const {
      delivery_type, // pickup | delivery
      payment_method, // online | in_store
      address_id = null,
      items, // [{ productId, qty }]
    } = req.body || {};

    if (!["pickup", "delivery"].includes(delivery_type)) {
      return res.status(400).json({ message: "delivery_type inválido" });
    }
    if (!["online", "in_store"].includes(payment_method)) {
      return res.status(400).json({ message: "payment_method inválido" });
    }
    if (delivery_type === "delivery" && !address_id) {
      return res
        .status(400)
        .json({ message: "address_id requerido para delivery" });
    }
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ message: "items es requerido" });
    }

    // merge duplicados + valida qty
    const map = new Map();
    for (const it of items) {
      const productId = String(it.productId ?? it.id ?? "");
      const qty = Number(it.qty ?? 0);
      if (!productId || !Number.isInteger(qty) || qty <= 0) {
        return res.status(400).json({ message: "items inválidos" });
      }
      map.set(productId, (map.get(productId) ?? 0) + qty);
    }
    const merged = Array.from(map.entries()).map(([productId, qty]) => ({
      productId,
      qty,
    }));

    const orderId = genOrderId();

    await client.query("BEGIN");

    // Lock inventory para consistencia
    const ids = merged.map((x) => x.productId);
    const { rows } = await client.query(
      `
      SELECT
        p.id, p.name, p.price,
        i.stock_on_hand, i.stock_reserved,
        (i.stock_on_hand - i.stock_reserved) AS stock_available
      FROM products p
      JOIN inventory i ON i.product_id = p.id
      WHERE p.id = ANY($1::text[])
        AND p.active = TRUE
      FOR UPDATE OF i;
      `,
      [ids]
    );

    if (rows.length !== ids.length) {
      await client.query("ROLLBACK");
      return res
        .status(400)
        .json({ message: "Producto inexistente o inactivo" });
    }

    const byId = new Map(rows.map((r) => [r.id, r]));

    // validar stock
    for (const it of merged) {
      const p = byId.get(it.productId);
      if (!p) {
        await client.query("ROLLBACK");
        return res
          .status(400)
          .json({ message: `Producto inválido: ${it.productId}` });
      }

      if (Number(p.stock_available) < it.qty) {
        await client.query("ROLLBACK");
        return res.status(409).json({
          message: `Stock insuficiente para ${p.name}`,
          productId: p.id,
          available: Number(p.stock_available),
          requested: it.qty,
        });
      }
    }

    // totales
    const orderItems = merged.map((it) => {
      const p = byId.get(it.productId);
      const unit_price = Number(p.price);
      const line_total = unit_price * it.qty;
      return { ...it, unit_price, line_total };
    });

    const subtotal = orderItems.reduce((acc, x) => acc + x.line_total, 0);
    const shipping_cost = 0;
    const total = subtotal + shipping_cost;

    // insertar order
    await client.query(
      `
      INSERT INTO orders
      (id, user_id, delivery_type, payment_method, status, address_id, subtotal, shipping_cost, total)
      VALUES
      ($1,$2,$3,$4,'pending_payment',$5,$6,$7,$8)
      `,
      [orderId, userId, delivery_type, payment_method, address_id, subtotal, shipping_cost, total]
    );

    // insertar items + reservar stock + movimientos
    for (const it of orderItems) {
      await client.query(
        `
        INSERT INTO order_items (order_id, product_id, qty, unit_price, line_total)
        VALUES ($1,$2,$3,$4,$5)
        `,
        [orderId, it.productId, it.qty, it.unit_price, it.line_total]
      );

      await client.query(
        `UPDATE inventory SET stock_reserved = stock_reserved + $2 WHERE product_id = $1`,
        [it.productId, it.qty]
      );

      await client.query(
        `
        INSERT INTO stock_movements (product_id, order_id, user_id, movement_type, qty, note)
        VALUES ($1,$2,$3,'reserve',$4,'Reserva por creación de orden')
        `,
        [it.productId, orderId, userId, it.qty]
      );
    }

    await client.query("COMMIT");

    res.status(201).json({
      id: orderId,
      status: "pending_payment",
      delivery_type,
      payment_method,
      address_id,
      subtotal,
      shipping_cost,
      total,
      items: orderItems.map((x) => ({
        product_id: x.productId,
        qty: x.qty,
        unit_price: x.unit_price,
        line_total: x.line_total,
      })),
    });
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {}
    next(err);
  } finally {
    client.release();
  }
}
