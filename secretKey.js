import "./env.js";

if (!process.env.JWT_SECRET) {
  throw new Error("JWT_SECRET no está definido. Revisa tu .env");
}

export const JWT_SECRET = process.env.JWT_SECRET;
