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
  }),
);
app.use(express.json());

// Morgan: reduce ruido (no logs para polling/catálogo)
morgan.token("cache", (_req, res) => res.getHeader("X-Cache") || "-");
app.use(
  morgan(
    ":method :url :status :res[content-length] - :response-time ms :cache",
    {
      skip: (req) => {
        if (req.method === "GET" && req.path === "/api/products") return true;
        if (
          req.method === "GET" &&
          (req.path === "/api/products/meta" || req.path === "/api/orders/meta")
        )
          return true;
        return false;
      },
    },
  ),
);

// Fuerza UTF-8 en respuestas JSON (útil en Windows)
app.use((_req, res, next) => {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  next();
});

/* =========================
   Cache liviano (in-memory)
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
   ✅ Auto-cancel config (OPCIÓN B)
========================= */
const AUTO_CANCEL_EVERY_MS = 30_000; // cada 30s
const AUTO_CANCEL_TTL_MINUTES = 15;

async function autoCancelExpiredOnlineOrders({ limit = 200 } = {}) {
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

if (process.env.NODE_ENV !== "test") {
  setInterval(() => {
    autoCancelExpiredOnlineOrders({ limit: 200 }).catch((e) =>
      console.error("[autoCancelExpiredOnlineOrders tick]", e),
    );
  }, AUTO_CANCEL_EVERY_MS);
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
      [String(name).trim(), String(email).toLowerCase(), hash, normalizedRole],
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
    { expiresIn: "8h" },
  );

  return res.json({
    token,
    user: { id: user.id, name: user.name, email: user.email, role: user.role },
  });
});

/**
 * ✅ Verificar contraseña (para acciones sensibles como soft delete)
 * POST /api/auth/verify-password
 * Body: { password }
 * Requiere: manager
 */
app.post(
  "/api/auth/verify-password",
  requireAuth,
  requireRole(["manager"]),
  async (req, res, next) => {
    try {
      const password = String(req.body?.password ?? "");
      if (!password)
        return res.status(400).json({ message: "Password requerido" });

      const r = await pool.query(
        `SELECT password_hash FROM users WHERE id = $1`,
        [req.user.id],
      );
      const row = r.rows[0];
      if (!row) return res.status(401).json({ message: "No autenticado" });

      const ok = await bcrypt.compare(password, row.password_hash);
      if (!ok) return res.status(401).json({ message: "Password incorrecto" });

      return res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  },
);

/* =========================
   Products
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

    if (
      minPrice !== undefined &&
      minPrice !== null &&
      String(minPrice) !== ""
    ) {
      values.push(Number(minPrice));
      filters.push(`p.price >= $${values.length}`);
    }

    if (
      maxPrice !== undefined &&
      maxPrice !== null &&
      String(maxPrice) !== ""
    ) {
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

/* =========================
   Categories
========================= */
app.get("/api/categories", async (_req, res, next) => {
  try {
    const r = await pool.query(
      `SELECT id, name FROM categories ORDER BY name ASC`,
    );
    setShortCacheHeaders(res);
    res.json(r.rows);
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
      [id],
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

// =========================
// Products (ops) - Crear producto (solo manager)
// =========================
app.post(
  "/api/products",
  requireAuth,
  requireRole(["manager"]),
  async (req, res, next) => {
    const client = await pool.connect();
    try {
      const {
        id,
        sku,
        name,
        description,
        price,
        status,
        image,
        image_url,
        active,
        category,
        category_id,
        stock_on_hand,
      } = req.body ?? {};

      const vSku = String(sku ?? "").trim();
      const vName = String(name ?? "").trim();

      if (!vSku) return res.status(400).json({ message: "SKU inválido" });
      if (!vName) return res.status(400).json({ message: "Nombre inválido" });

      const nPrice = Number(price);
      if (!Number.isFinite(nPrice) || nPrice < 0) {
        return res.status(400).json({ message: "Precio inválido" });
      }

      const vDesc = String(description ?? "").trim();
      const vStatus = String(status ?? "none").trim() || "none";
      const vActive = active === undefined ? true : Boolean(active);

      const img = image_url !== undefined ? image_url : image;
      const vImg = String(img ?? "").trim();

      let resolvedCategoryId = null;

      if (
        category_id !== undefined &&
        category_id !== null &&
        String(category_id).trim() !== ""
      ) {
        resolvedCategoryId = String(category_id).trim();
        const r = await client.query(
          `SELECT id FROM categories WHERE id = $1 LIMIT 1`,
          [resolvedCategoryId],
        );
        if (!r.rows.length)
          return res.status(400).json({ message: "Categoría inválida" });
      } else if (
        category !== undefined &&
        category !== null &&
        String(category).trim() !== ""
      ) {
        const r = await client.query(
          `SELECT id FROM categories WHERE name = $1 LIMIT 1`,
          [String(category).trim()],
        );
        if (!r.rows.length)
          return res.status(400).json({ message: "Categoría inválida" });
        resolvedCategoryId = r.rows[0].id;
      } else {
        return res
          .status(400)
          .json({ message: "Categoría requerida (category o category_id)" });
      }

      const newId = String(id ?? `p${Date.now()}`).trim();

      const rawStock =
        stock_on_hand === undefined ||
        stock_on_hand === null ||
        String(stock_on_hand) === ""
          ? 0
          : Number(stock_on_hand);

      if (!Number.isInteger(rawStock) || rawStock < 0) {
        return res
          .status(400)
          .json({ message: "stock_on_hand inválido (entero ≥ 0)" });
      }

      await client.query("BEGIN");

      let createdProduct;
      try {
        const rProd = await client.query(
          `
          INSERT INTO products (id, sku, name, description, price, status, image_url, active, category_id)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
          RETURNING id, sku, name, description, price, image_url AS image, status, active, category_id
          `,
          [
            newId,
            vSku,
            vName,
            vDesc,
            nPrice,
            vStatus,
            vImg,
            vActive,
            resolvedCategoryId,
          ],
        );
        createdProduct = rProd.rows[0];
      } catch (e) {
        if (String(e?.code) === "23505") {
          await client.query("ROLLBACK");
          return res
            .status(409)
            .json({ message: "SKU duplicado o ID duplicado" });
        }
        throw e;
      }

      await client.query(
        `
        INSERT INTO inventory (product_id, stock_on_hand, stock_reserved)
        VALUES ($1,$2,0)
        `,
        [createdProduct.id, rawStock],
      );

      const rCatName = await client.query(
        `SELECT name FROM categories WHERE id = $1`,
        [createdProduct.category_id],
      );

      await client.query("COMMIT");

      invalidateProductsCache();

      return res.status(201).json({
        message: "Producto creado",
        product: {
          ...createdProduct,
          category: rCatName.rows[0]?.name ?? null,
          stock: Math.max(rawStock - 0, 0),
        },
      });
    } catch (e) {
      try {
        await client.query("ROLLBACK");
      } catch {}
      next(e);
    } finally {
      client.release();
    }
  },
);

// =========================
// Products (ops) - Update parcial (solo manager)
// =========================
app.patch(
  "/api/products/:id",
  requireAuth,
  requireRole(["manager"]),
  async (req, res, next) => {
    try {
      const { id } = req.params;

      const {
        sku,
        name,
        description,
        price,
        status,
        image,
        image_url,
        active,
        category,
        category_id,
      } = req.body ?? {};

      const set = [];
      const values = [];
      const pushSet = (sqlFrag, v) => {
        values.push(v);
        set.push(`${sqlFrag} = $${values.length}`);
      };

      if (sku !== undefined) {
        const v = String(sku).trim();
        if (!v) return res.status(400).json({ message: "SKU inválido" });
        pushSet("sku", v);
      }

      if (name !== undefined) {
        const v = String(name).trim();
        if (!v) return res.status(400).json({ message: "Nombre inválido" });
        pushSet("name", v);
      }

      if (description !== undefined) {
        pushSet("description", String(description ?? "").trim());
      }

      if (price !== undefined) {
        const n = Number(price);
        if (!Number.isFinite(n) || n < 0)
          return res.status(400).json({ message: "Precio inválido" });
        pushSet("price", n);
      }

      if (status !== undefined) {
        const v = String(status).trim();
        if (!v) return res.status(400).json({ message: "Status inválido" });
        pushSet("status", v);
      }

      const img = image_url !== undefined ? image_url : image;
      if (img !== undefined) {
        pushSet("image_url", String(img ?? "").trim());
      }

      if (active !== undefined) {
        pushSet("active", Boolean(active));
      }

      let resolvedCategoryId = null;

      if (
        category_id !== undefined &&
        category_id !== null &&
        String(category_id).trim() !== ""
      ) {
        resolvedCategoryId = String(category_id).trim();
      } else if (
        category !== undefined &&
        category !== null &&
        String(category).trim() !== ""
      ) {
        const rCat = await pool.query(
          `SELECT id FROM categories WHERE name = $1 LIMIT 1`,
          [String(category).trim()],
        );
        if (!rCat.rows.length)
          return res.status(400).json({ message: "Categoría inválida" });
        resolvedCategoryId = rCat.rows[0].id;
      }

      if (resolvedCategoryId !== null) {
        pushSet("category_id", resolvedCategoryId);
      }

      if (!set.length) {
        return res
          .status(400)
          .json({ message: "No hay campos para actualizar" });
      }

      set.push(`updated_at = NOW()`);

      values.push(id);
      const sql = `
        UPDATE products
        SET ${set.join(", ")}
        WHERE id = $${values.length} AND active = TRUE
        RETURNING id, sku, name, description, price, image_url AS image, status, active, category_id
      `;

      let updated;
      try {
        const r = await pool.query(sql, values);
        updated = r.rows[0];
      } catch (e) {
        if (String(e?.code) === "23505") {
          return res.status(409).json({ message: "SKU duplicado" });
        }
        throw e;
      }

      if (!updated) {
        return res.status(404).json({ message: "Producto no encontrado" });
      }

      const rCatName = await pool.query(
        `SELECT name FROM categories WHERE id = $1`,
        [updated.category_id],
      );

      invalidateProductsCache();

      return res.json({
        message: "Producto actualizado",
        product: {
          ...updated,
          category: rCatName.rows[0]?.name ?? null,
        },
      });
    } catch (e) {
      next(e);
    }
  },
);

/**
 * ✅ Soft delete (manager)
 * PATCH /api/products/:id/deactivate
 */
app.patch(
  "/api/products/:id/deactivate",
  requireAuth,
  requireRole(["manager"]),
  async (req, res, next) => {
    try {
      const { id } = req.params;

      const r = await pool.query(
        `
        UPDATE products
        SET active = FALSE,
            updated_at = NOW()
        WHERE id = $1 AND active = TRUE
        RETURNING id, sku, name, active
        `,
        [id],
      );

      if (!r.rows.length) {
        return res.status(404).json({ message: "Producto no encontrado" });
      }

      invalidateProductsCache();
      return res.json({ message: "Producto desactivado", product: r.rows[0] });
    } catch (e) {
      next(e);
    }
  },
);

// =========================
// Inventory (ops)
// =========================
app.patch(
  "/api/inventory/:productId",
  requireAuth,
  requireRole(["staff", "manager"]),
  async (req, res, next) => {
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
  },
);

/* =========================
   ✅ Inventory (read) — staff/manager (NUEVO)
========================= */
app.get(
  "/api/inventory",
  requireAuth,
  requireRole(["staff", "manager"]),
  async (_req, res, next) => {
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
  },
);

/* =========================
   Orders (customer)
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

      if (
        !deliveryType ||
        !paymentMethod ||
        !Array.isArray(items) ||
        !items.length
      ) {
        return res.status(400).json({ message: "Payload inválido" });
      }

      const expiresAt =
        paymentMethod === "online"
          ? new Date(Date.now() + AUTO_CANCEL_TTL_MINUTES * 60 * 1000)
          : null;

      const addressId =
        deliveryType === "delivery" ? (address_id ?? null) : null;

      const mapQty = new Map();
      for (const it of items) {
        const productId = String(it?.productId ?? it?.id ?? "");
        const qty = Number(it?.qty ?? 0);
        if (!productId || !Number.isInteger(qty) || qty <= 0) {
          return res.status(400).json({ message: "Items inválidos" });
        }
        mapQty.set(productId, (mapQty.get(productId) ?? 0) + qty);
      }
      const mergedItems = Array.from(mapQty.entries()).map(
        ([productId, qty]) => ({
          productId,
          qty,
        }),
      );

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
          return res
            .status(400)
            .json({ message: "Producto inexistente o inactivo" });
        }

        let subtotal = 0;

        for (const it of mergedItems) {
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
              notes
                ? String(notes).trim()
                : "Reserva por orden pending_payment",
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
      } catch (_e) {
        await client.query("ROLLBACK");
        return res.status(500).json({ message: "Error creando orden" });
      } finally {
        client.release();
      }
    } catch (e) {
      next(e);
    }
  },
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
  },
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
  },
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
      res.json(r.rows);
    } catch (e) {
      next(e);
    }
  },
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

      if (!r.rows.length)
        return res.status(404).json({ message: "Orden no encontrada" });

      setShortCacheHeaders(res);
      res.json(r.rows[0]);
    } catch (e) {
      next(e);
    }
  },
);

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

      // =========================
      // ✅ RBAC extra: SOLO MANAGER puede setear SHIPPED
      // (la UI ya lo restringe, esto cierra el bypass por API)
      // =========================
      if (status === "shipped" && req.user?.role !== "manager") {
        return res
          .status(403)
          .json({ message: "Solo manager puede marcar En despacho." });
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

      // =========================
      // ✅ GUARDRAILS (para evitar stock inconsistente)
      // =========================
      // No permitir despachar si la orden ya estaba cancelada
      if (status === "shipped" && prevStatus === "cancelled") {
        await client.query("ROLLBACK");
        return res
          .status(409)
          .json({ message: "No puedes despachar una orden cancelada." });
      }

      // No permitir cancelar si ya se despachó (porque ya se descontó on_hand)
      if (status === "cancelled" && prevStatus === "shipped") {
        await client.query("ROLLBACK");
        return res
          .status(409)
          .json({ message: "No puedes cancelar una orden ya despachada." });
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

      // =========================
      // ✅ BLOQUE NUEVO: SHIPPED ("En despacho") -> descuenta on_hand + libera reserved + movimiento out
      // 👉 Pegado aquí a propósito: después de UPDATE orders, antes del bloque CANCELLED
      // =========================
      if (status === "shipped" && prevStatus !== "shipped") {
        const items = await client.query(
          `SELECT product_id, qty FROM order_items WHERE order_id = $1`,
          [id],
        );

        for (const it of items.rows) {
          const qty = Number(it.qty);

          // 1) Ajuste inventario: baja on_hand y baja reserved
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

          // 2) Movimiento OUT idempotente (no duplica si ya se registró)
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

      // =========================
      // ✅ BLOQUE EXISTENTE: CANCELLED -> libera reservas + release_reserve + void payment
      // =========================
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
      await client.query("ROLLBACK");
      next(e);
    } finally {
      client.release();
    }
  },
);

/**
 * ✅ Sweep manual (manager) para QA / operación
 * POST /api/orders/sweep-expired
 */
app.post(
  "/api/orders/sweep-expired",
  requireAuth,
  requireRole(["manager"]),
  async (_req, res, next) => {
    try {
      const cancelled = await autoCancelExpiredOnlineOrders({ limit: 500 });
      return res.json({ ok: true, cancelled });
    } catch (e) {
      next(e);
    }
  },
);

/* =========================
   Chat RAG (gratis) — FTS sobre kb_chunks.tsv
========================= */
app.post("/api/chat", async (req, res, next) => {
  try {
    const message = String(req.body?.message ?? "").trim();
    if (!message) return res.status(400).json({ message: "message requerido" });

    let rows = [];
    try {
      const r = await pool.query(
        `
        SELECT id, source, source_id, title, content, metadata,
               ts_rank_cd(tsv, websearch_to_tsquery('spanish', $1)) AS rank
        FROM kb_chunks
        WHERE tsv @@ websearch_to_tsquery('spanish', $1)
        ORDER BY rank DESC
        LIMIT 5;
        `,
        [message],
      );
      rows = r.rows;
    } catch (e) {
      const msg = String(e?.message ?? "").toLowerCase();

      // Si no existe tsv, es una falla de setup: mejor devolver mensaje claro
      if (msg.includes("column") && msg.includes("tsv")) {
        return res.status(500).json({
          message:
            "Chat no disponible: falta activar Full-Text Search (columna tsv) en kb_chunks.",
        });
      }

      // Fallback seguro para inputs raros (evita romper por sintaxis tsquery)
      const r2 = await pool.query(
        `
        SELECT id, source, source_id, title, content, metadata,
               ts_rank_cd(tsv, plainto_tsquery('spanish', $1)) AS rank
        FROM kb_chunks
        WHERE tsv @@ plainto_tsquery('spanish', $1)
        ORDER BY rank DESC
        LIMIT 5;
        `,
        [message],
      );
      rows = r2.rows;
    }

    if (!rows.length) {
      return res.json({
        reply:
          "No tengo info en Ferretex para eso. Prueba con el nombre del producto, SKU o categoría.",
        sources: [],
      });
    }

    const bullets = rows.map((r, i) => {
      const title = r.title ? `**${r.title}**` : `Resultado ${i + 1}`;
      const snippet = (r.content || "")
        .slice(0, 220)
        .replace(/\s+/g, " ")
        .trim();
      return `- ${title}: ${snippet}… [#${i + 1}]`;
    });

    const reply =
      `Encontré esta info relevante:\n` +
      bullets.join("\n") +
      `\n\nSi me dices “¿cuál de estos?” te guío con el más adecuado.`;

    const sources = rows.map((r, i) => ({
      ref: `#${i + 1}`,
      source: r.source,
      source_id: r.source_id,
      title: r.title,
      rank: Number(r.rank),
      metadata: r.metadata,
    }));

    return res.json({ reply, sources });
  } catch (e) {
    next(e);
  }
});

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
