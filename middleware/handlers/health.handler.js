import { pingDB } from "../../consultas.js";

export async function healthCheck(_req, res, next) {
  try {
    const db = await pingDB();
    res.json({ ok: true, db });
  } catch (e) {
    next(e);
  }
}
