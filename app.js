import express from "express";
import cors from "cors";
import morgan from "morgan";

import apiRouter from "./routes/index.routes.js";
import { startAutoCancelJob } from "./jobs/autoCancelExpiredOnlineOrders.js";

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
  morgan(":method :url :status :res[content-length] - :response-time ms :cache", {
    skip: (req) => {
      if (req.method === "GET" && req.path === "/api/products") return true;
      if (
        req.method === "GET" &&
        (req.path === "/api/products/meta" || req.path === "/api/orders/meta")
      )
        return true;
      return false;
    },
  }),
);

// Fuerza UTF-8 en respuestas JSON (útil en Windows)
app.use((_req, res, next) => {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  next();
});

/* =========================
   Router maestro
========================= */
app.use("/api", apiRouter);

/* =========================
   Job auto-cancel (no en test)
========================= */
if (process.env.NODE_ENV !== "test") {
  startAutoCancelJob();
}

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
