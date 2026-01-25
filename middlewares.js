import jwt from "jsonwebtoken";
import { JWT_SECRET } from "./secretKey.js";

export function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const [type, token] = header.split(" ");

  if (type !== "Bearer" || !token) {
    return res.status(401).json({ message: "Token requerido" });
  }

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = payload; // { id, email, role }
    return next();
  } catch {
    return res.status(401).json({ message: "Token inválido" });
  }
}

export function requireRole(roles = []) {
  return (req, res, next) => {
    const role = req.user?.role ?? "customer";
    if (!roles.includes(role)) {
      return res.status(403).json({ message: "No autorizado" });
    }
    return next();
  };
}
