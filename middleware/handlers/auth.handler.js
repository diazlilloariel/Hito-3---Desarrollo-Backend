import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { pool } from "../../consultas.js";
import { JWT_SECRET } from "../../secretKey.js";

export async function register(req, res) {
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
  } catch {
    return res.status(409).json({ message: "Email ya registrado" });
  }
}

export async function login(req, res) {
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
}

export async function verifyPassword(req, res, next) {
  try {
    const password = String(req.body?.password ?? "");
    if (!password) return res.status(400).json({ message: "Password requerido" });

    const r = await pool.query(`SELECT password_hash FROM users WHERE id = $1`, [
      req.user.id,
    ]);

    const row = r.rows[0];
    if (!row) return res.status(401).json({ message: "No autenticado" });

    const ok = await bcrypt.compare(password, row.password_hash);
    if (!ok) return res.status(401).json({ message: "Password incorrecto" });

    return res.json({ ok: true });
  } catch (e) {
    next(e);
  }
}
