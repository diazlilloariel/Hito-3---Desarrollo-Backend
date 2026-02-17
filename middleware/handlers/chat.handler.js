import { pool } from "../../consultas.js";

export async function chatRag(req, res, next) {
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

      if (msg.includes("column") && msg.includes("tsv")) {
        return res.status(500).json({
          message:
            "Chat no disponible: falta activar Full-Text Search (columna tsv) en kb_chunks.",
        });
      }

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
}
