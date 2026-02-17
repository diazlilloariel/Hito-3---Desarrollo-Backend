import { pool } from "../../consultas.js";
import {
  buildProductsCacheKey,
  getCachedProducts,
  setCachedProducts,
  setShortCacheHeaders,
  invalidateProductsCache,
} from "../../cache/productsCache.js";

export async function listProducts(req, res, next) {
  try {
    const cacheKey = buildProductsCacheKey(req);

    const cached = getCachedProducts(cacheKey);
    if (cached) {
      res.setHeader("X-Cache", "HIT");
      setShortCacheHeaders(res);
      return res.json(cached);
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

    setCachedProducts(cacheKey, data);

    res.setHeader("X-Cache", "MISS");
    setShortCacheHeaders(res);
    return res.json(data);
  } catch (e) {
    next(e);
  }
}

export async function productsMeta(_req, res, next) {
  try {
    const r = await pool.query(`
      SELECT
        GREATEST(
          COALESCE((SELECT MAX(updated_at) FROM products), NOW()),
          COALESCE((SELECT MAX(updated_at) FROM inventory), NOW())
        ) AS last_changed
    `);

    setShortCacheHeaders(res);
    return res.json({ lastChanged: r.rows[0].last_changed });
  } catch (e) {
    next(e);
  }
}

export async function getProductById(req, res, next) {
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
}

export async function createProduct(req, res, next) {
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

    if (category_id !== undefined && category_id !== null && String(category_id).trim() !== "") {
      resolvedCategoryId = String(category_id).trim();
      const r = await client.query(`SELECT id FROM categories WHERE id = $1 LIMIT 1`, [resolvedCategoryId]);
      if (!r.rows.length) return res.status(400).json({ message: "Categoría inválida" });
    } else if (category !== undefined && category !== null && String(category).trim() !== "") {
      const r = await client.query(`SELECT id FROM categories WHERE name = $1 LIMIT 1`, [String(category).trim()]);
      if (!r.rows.length) return res.status(400).json({ message: "Categoría inválida" });
      resolvedCategoryId = r.rows[0].id;
    } else {
      return res.status(400).json({ message: "Categoría requerida (category o category_id)" });
    }

    const newId = String(id ?? `p${Date.now()}`).trim();

    const rawStock =
      stock_on_hand === undefined || stock_on_hand === null || String(stock_on_hand) === ""
        ? 0
        : Number(stock_on_hand);

    if (!Number.isInteger(rawStock) || rawStock < 0) {
      return res.status(400).json({ message: "stock_on_hand inválido (entero ≥ 0)" });
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
        [newId, vSku, vName, vDesc, nPrice, vStatus, vImg, vActive, resolvedCategoryId],
      );
      createdProduct = rProd.rows[0];
    } catch (e) {
      if (String(e?.code) === "23505") {
        await client.query("ROLLBACK");
        return res.status(409).json({ message: "SKU duplicado o ID duplicado" });
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

    const rCatName = await client.query(`SELECT name FROM categories WHERE id = $1`, [createdProduct.category_id]);

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
    try { await client.query("ROLLBACK"); } catch {}
    next(e);
  } finally {
    client.release();
  }
}

export async function patchProduct(req, res, next) {
  try {
    const { id } = req.params;

    const { sku, name, description, price, status, image, image_url, active, category, category_id } = req.body ?? {};

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

    if (description !== undefined) pushSet("description", String(description ?? "").trim());

    if (price !== undefined) {
      const n = Number(price);
      if (!Number.isFinite(n) || n < 0) return res.status(400).json({ message: "Precio inválido" });
      pushSet("price", n);
    }

    if (status !== undefined) {
      const v = String(status).trim();
      if (!v) return res.status(400).json({ message: "Status inválido" });
      pushSet("status", v);
    }

    const img = image_url !== undefined ? image_url : image;
    if (img !== undefined) pushSet("image_url", String(img ?? "").trim());

    if (active !== undefined) pushSet("active", Boolean(active));

    let resolvedCategoryId = null;
    if (category_id !== undefined && category_id !== null && String(category_id).trim() !== "") {
      resolvedCategoryId = String(category_id).trim();
    } else if (category !== undefined && category !== null && String(category).trim() !== "") {
      const rCat = await pool.query(`SELECT id FROM categories WHERE name = $1 LIMIT 1`, [String(category).trim()]);
      if (!rCat.rows.length) return res.status(400).json({ message: "Categoría inválida" });
      resolvedCategoryId = rCat.rows[0].id;
    }
    if (resolvedCategoryId !== null) pushSet("category_id", resolvedCategoryId);

    if (!set.length) return res.status(400).json({ message: "No hay campos para actualizar" });

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
      if (String(e?.code) === "23505") return res.status(409).json({ message: "SKU duplicado" });
      throw e;
    }

    if (!updated) return res.status(404).json({ message: "Producto no encontrado" });

    const rCatName = await pool.query(`SELECT name FROM categories WHERE id = $1`, [updated.category_id]);

    invalidateProductsCache();

    return res.json({
      message: "Producto actualizado",
      product: { ...updated, category: rCatName.rows[0]?.name ?? null },
    });
  } catch (e) {
    next(e);
  }
}

export async function deactivateProduct(req, res, next) {
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

    if (!r.rows.length) return res.status(404).json({ message: "Producto no encontrado" });

    invalidateProductsCache();
    return res.json({ message: "Producto desactivado", product: r.rows[0] });
  } catch (e) {
    next(e);
  }
}
