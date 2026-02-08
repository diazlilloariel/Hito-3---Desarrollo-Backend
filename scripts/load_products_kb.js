// scripts/load_products_kb.js
import "dotenv/config";
import { pool } from "../consultas.js";

const dbg = await pool.query("SELECT current_database() AS db, current_schema() AS schema;");
console.log("RUNNING ON:", dbg.rows[0]);


function productToText(p) {
  return [
    `Producto: ${p.name}`,
    `SKU: ${p.sku}`,
    `Categoría: ${p.category}`,
    p.description ? `Descripción: ${p.description}` : null,
    p.status ? `Estado: ${p.status}` : null,
  ].filter(Boolean).join("\n");
}

async function main() {
  const { rows } = await pool.query(`
    SELECT p.id, p.sku, p.name, p.description, p.status, c.name AS category
    FROM products p
    JOIN categories c ON c.id = p.category_id
    WHERE p.active = TRUE
    ORDER BY p.name ASC
  `);

  for (const p of rows) {
    await pool.query(`DELETE FROM kb_chunks WHERE source='product' AND source_id=$1`, [String(p.id)]);
    await pool.query(
      `INSERT INTO kb_chunks (source, source_id, title, content, metadata)
       VALUES ($1,$2,$3,$4,$5)`,
      ["product", String(p.id), p.name, productToText(p), { sku: p.sku, category: p.category, status: p.status }]
    );
  }

  console.log("OK productos cargados:", rows.length);
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
