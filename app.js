import express from "express";
import cors from "cors";
import morgan from "morgan";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";

import { pool, pingDB } from "./consultas.js";
import { JWT_SECRET } from "./secretKey.js";
import { requireAuth, requireRole } from "./middlewares.js";

const app = express();

/* =========================
   Middlewares base
========================= */
app.use(
  cors({
    origin: true,
    credentials: true,
  })
);
app.use(express.json());

// Morgan: reduce ruido (no logs para polling/catálogo)
morgan.token("cache", (_req, res) => res.getHeader("X-Cache") || "-");
app.use(
  morgan(":method :url :status :res[content-length] - :response-time ms :cache", {
    skip: (req) => {
      // Evita spam visual: el frontend puede hacer polling y/o múltiples hits
      if (req.method === "GET" && req.path === "/api/products") return true;
      if (req.method === "GET" && (req.path === "/api/products/meta" || req.path === "/api/orders/meta")) return true;
      return false;
    },
  })
);

// Fuerza UTF-8 en respuestas JSON (útil en Windows)
app.use((_req, res, next) => {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  next();
});

/* =========================
   Cache liviano (in-memory)
   Objetivo: evitar hits a BD por loops del frontend
========================= */
const PRODUCTS_CACHE_TTL_MS = 1500; // 1.5s
const productsCache = new Map(); // key -> { at, data }

function buildProductsCacheKey(req) {
  const q = req.query ?? {};
  const keys = Object.keys(q).sort();
  const parts = keys.map((k) => `${k}=${String(q[k])}`);
  return `/api/products?${parts.join("&")}`;
}

function setShortCacheHeaders(res) {
  res.setHeader("Cache-Control", "public, max-age=2"); // 2s
}

function invalidateProductsCache() {
  productsCache.clear();
}

/* =========================
   Health
========================= */
app.get("/api/health", async (_req, res, next) => {
  try {
    const db = await pingDB();
    res.json({ ok: true, db });
  } catch (e) {
    next(e);
  }
});

/* =========================
   Auth
========================= */
app.post("/api/auth/register", async (req, res) => {
  try {
    const { name, email, password, role } = req.body ?? {};
    if (!name || !email || !password) {
      return res.status(400).json({ message: "Faltan campos" });
    }

    const normalizedRole = role ?? "customer";
    const allowedRoles = ["customer", "staff", "manager"];
    if (!allowedRoles.includes(normalizedRole)) {
      return res.status(400).json({ message: "Rol inválido" });
    }

    const hash = await bcrypt.hash(password, 10);

    const r = await pool.query(
      `
      INSERT INTO users (name, email, password_hash, role)
      VALUES ($1,$2,$3,$4)
      RETURNING id, name, email, role
      `,
      [String(name).trim(), String(email).toLowerCase(), hash, normalizedRole]
    );

    return res.status(201).json(r.rows[0]);
  } catch (_e) {
    return res.status(409).json({ message: "Email ya registrado" });
  }
});

app.post("/api/auth/login", async (req, res) => {
  const { email, password } = req.body ?? {};
  if (!email || !password) {
    return res.status(400).json({ message: "Faltan campos" });
  }

  const r = await pool.query(`SELECT * FROM users WHERE email = $1`, [
    String(email).toLowerCase(),
  ]);

  const user = r.rows[0];
  if (!user) return res.status(401).json({ message: "Credenciales inválidas" });

  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) return res.status(401).json({ message: "Credenciales inválidas" });

  const token = jwt.sign(
    { id: user.id, email: user.email, role: user.role },
    JWT_SECRET,
    { expiresIn: "8h" }
  );

  return res.json({
    token,
    user: { id: user.id, name: user.name, email: user.email, role: user.role },
  });
});

/* =========================
   Products
   - stock expuesto = stock disponible (on_hand - reserved)
========================= */
app.get("/api/products", async (req, res, next) => {
  try {
    const cacheKey = buildProductsCacheKey(req);
    const cached = productsCache.get(cacheKey);
    const now = Date.now();

    if (cached && now - cached.at < PRODUCTS_CACHE_TTL_MS) {
      res.setHeader("X-Cache", "HIT");
      setShortCacheHeaders(res);
      return res.json(cached.data);
    }

    const { q, cat, status, sort, inStock, minPrice, maxPrice } = req.query;

    const filters = ["p.active = TRUE"];
    const values = [];

    if (q) {
      values.push(`%${String(q).toLowerCase()}%`);
      filters.push(`LOWER(p.name) LIKE $${values.length}`);
    }

    if (cat && cat !== "all") {
      values.push(String(cat));
      filters.push(`c.name = $${values.length}`);
    }

    if (status && status !== "all") {
      values.push(String(status));
      filters.push(`p.status = $${values.length}`);
    }

    if (String(inStock) === "true") {
      filters.push(`(i.stock_on_hand - i.stock_reserved) > 0`);
    }

    if (minPrice !== undefined && minPrice !== null && String(minPrice) !== "") {
      values.push(Number(minPrice));
      filters.push(`p.price >= $${values.length}`);
    }

    if (maxPrice !== undefined && maxPrice !== null && String(maxPrice) !== "") {
      values.push(Number(maxPrice));
      filters.push(`p.price <= $${values.length}`);
    }

    const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";

    const orderBy =
      sort === "price_desc"
        ? "ORDER BY p.price DESC"
        : sort === "name_asc"
        ? "ORDER BY p.name ASC"
        : sort === "name_desc"
        ? "ORDER BY p.name DESC"
        : "ORDER BY p.price ASC";

    const sql = `
      SELECT
        p.id,
        p.sku,
        p.name,
        p.description,
        p.price,
        p.image_url AS image,
        p.status,
        c.name AS category,
        GREATEST((i.stock_on_hand - i.stock_reserved), 0) AS stock
      FROM products p
      JOIN categories c ON c.id = p.category_id
      JOIN inventory i ON i.product_id = p.id
      ${where}
      ${orderBy}
    `;

    const r = await pool.query(sql, values);
    const data = r.rows;

    productsCache.set(cacheKey, { at: now, data });

    res.setHeader("X-Cache", "MISS");
    setShortCacheHeaders(res);
    return res.json(data);
  } catch (e) {
    next(e);
  }
});

app.get("/api/products/meta", async (_req, res, next) => {
  try {
    const r = await pool.query(`
      SELECT
        GREATEST(
          COALESCE((SELECT MAX(updated_at) FROM products), NOW()),
          COALESCE((SELECT MAX(updated_at) FROM inventory), NOW())
        ) AS last_changed
    `);

    setShortCacheHeaders(res);
    res.json({ lastChanged: r.rows[0].last_changed });
  } catch (e) {
    next(e);
  }
});

app.get("/api/products/:id", async (req, res, next) => {
  try {
    const { id } = req.params;

    const r = await pool.query(
      `
      SELECT
        p.id,
        p.sku,
        p.name,
        p.description,
        p.price,
        p.image_url AS image,
        p.status,
        c.name AS category,
        GREATEST((i.stock_on_hand - i.stock_reserved), 0) AS stock
      FROM products p
      JOIN categories c ON c.id = p.category_id
      JOIN inventory i ON i.product_id = p.id
      WHERE p.id = $1 AND p.active = TRUE
      `,
      [id]
    );

    if (!r.rows.length) {
      return res.status(404).json({ message: "Producto no encontrado" });
    }

    setShortCacheHeaders(res);
    return res.json(r.rows[0]);
  } catch (e) {
    next(e);
  }
});

/* =========================
   Orders (customer)
   - pending_payment => RESERVA stock (stock_reserved + qty)
========================= */
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

app.post(
  "/api/orders",
  requireAuth,
  requireRole(["customer"]),
  async (req, res, next) => {
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

      const addressId = deliveryType === "delivery" ? (address_id ?? null) : null;

      const mapQty = new Map();
      for (const it of items) {
        const productId = String(it?.productId ?? it?.id ?? "");
        const qty = Number(it?.qty ?? 0);
        if (!productId || !Number.isInteger(qty) || qty <= 0) {
          return res.status(400).json({ message: "Items inválidos" });
        }
        mapQty.set(productId, (mapQty.get(productId) ?? 0) + qty);
      }
      const mergedItems = Array.from(mapQty.entries()).map(([productId, qty]) => ({
        productId,
        qty,
      }));

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
          [ids]
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
          INSERT INTO orders (id, user_id, delivery_type, payment_method, status, address_id, subtotal, shipping_cost, total)
          VALUES ($1,$2,$3,$4,'pending_payment',$5,$6,$7,$8)
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
          ]
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
            [orderId, p.id, qty, p.price, lineTotal]
          );

          await client.query(
            `UPDATE inventory SET stock_reserved = stock_reserved + $1 WHERE product_id = $2`,
            [qty, p.id]
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
            ]
          );
        }

        await client.query(
          `
          INSERT INTO payments (order_id, provider, status, amount, transaction_id)
          VALUES ($1,'webpay','initiated',$2,$3)
          ON CONFLICT (order_id) DO NOTHING
          `,
          [orderId, total, `TX-${Date.now()}`]
        );

        await client.query("COMMIT");

        // cambia stock disponible => invalida cache de productos
        invalidateProductsCache();

        return res.status(201).json({
          message: "Orden creada",
          orderId,
          status: "pending_payment",
          delivery_type: deliveryType,
          payment_method: paymentMethod,
          total,
          phone: phone ?? null,
          address: address ?? null,
        });
      } catch (_e) {
        await client.query("ROLLBACK");
        return res.status(500).json({ message: "Error creando orden" });
      } finally {
        client.release();
      }
    } catch (e) {
      next(e);
    }
  }
);

app.get(
  "/api/orders/me",
  requireAuth,
  requireRole(["customer"]),
  async (req, res, next) => {
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
          o.updated_at
        FROM orders o
        WHERE o.user_id = $1
        ORDER BY o.created_at DESC
        `,
        [req.user.id]
      );

      return res.json(r.rows);
    } catch (e) {
      next(e);
    }
  }
);

/* =========================
   Orders (ops) — staff/manager
========================= */
app.get(
  "/api/orders/meta",
  requireAuth,
  requireRole(["staff", "manager"]),
  async (_req, res, next) => {
    try {
      const r = await pool.query(`
        SELECT COALESCE(MAX(updated_at), NOW()) AS last_changed
        FROM orders
      `);

      setShortCacheHeaders(res);
      res.json({ lastChanged: r.rows[0].last_changed });
    } catch (e) {
      next(e);
    }
  }
);

app.get(
  "/api/orders",
  requireAuth,
  requireRole(["staff", "manager"]),
  async (req, res, next) => {
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
        filters.push(`(LOWER(o.id) LIKE $${values.length} OR LOWER(u.email) LIKE $${values.length})`);
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
      res.json(r.rows);
    } catch (e) {
      next(e);
    }
  }
);

app.get(
  "/api/orders/:id",
  requireAuth,
  requireRole(["staff", "manager"]),
  async (req, res, next) => {
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
        [id]
      );

      if (!r.rows.length) return res.status(404).json({ message: "Orden no encontrada" });

      setShortCacheHeaders(res);
      res.json(r.rows[0]);
    } catch (e) {
      next(e);
    }
  }
);

/* =========================
   Ops (staff/manager)
========================= */
app.patch(
  "/api/orders/:id/status",
  requireAuth,
  requireRole(["staff", "manager"]),
  async (req, res, next) => {
    const client = await pool.connect();
    try {
      const { id } = req.params;
      const raw = req.body?.status;

      if (!raw) return res.status(400).json({ message: "Status inválido" });

      const status = String(raw).trim().toLowerCase();

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

      await client.query("BEGIN");

      // estado actual
      const cur = await client.query(`SELECT id, status FROM orders WHERE id = $1 FOR UPDATE`, [id]);
      if (!cur.rows.length) {
        await client.query("ROLLBACK");
        return res.status(404).json({ message: "Orden no encontrada" });
      }

      const prevStatus = cur.rows[0].status;

      // actualiza estado + asegura updated_at
      const r = await client.query(
        `
        UPDATE orders
        SET status = $1,
            updated_at = NOW()
        WHERE id = $2
        RETURNING id, status
        `,
        [status, id]
      );

      // Si se cancela y antes no estaba cancelada: libera reserva
      if (status === "cancelled" && prevStatus !== "cancelled") {
        const items = await client.query(
          `SELECT product_id, qty FROM order_items WHERE order_id = $1`,
          [id]
        );

        for (const it of items.rows) {
          const qty = Number(it.qty);

          await client.query(
            `
            UPDATE inventory
            SET stock_reserved = GREATEST(stock_reserved - $1, 0)
            WHERE product_id = $2
            `,
            [qty, it.product_id]
          );

          await client.query(
            `
            INSERT INTO stock_movements (product_id, order_id, user_id, movement_type, qty, note)
            VALUES ($1,$2,$3,'release',$4,$5)
            `,
            [
              it.product_id,
              id,
              req.user.id,
              qty,
              "Liberación por cancelación",
            ]
          );
        }

        // stock disponible cambió => invalida cache de productos
        invalidateProductsCache();
      }

      await client.query("COMMIT");

      return res.json({ orderId: r.rows[0].id, status: r.rows[0].status });
    } catch (e) {
      await client.query("ROLLBACK");
      next(e);
    } finally {
      client.release();
    }
  }
);

/* =========================
   404 API
========================= */
app.use("/api", (_req, res) => {
  res.status(404).json({ message: "Ruta no encontrada" });
});

/* =========================
   Error handler central
========================= */
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ message: "Error interno" });
});

export default app;
