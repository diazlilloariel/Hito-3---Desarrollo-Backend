// routes/orders.routes.js
import { Router } from "express";
import { requireAuth, requireRole } from "../middlewares.js";
import { createOrderHandler } from "../middleware/handlers/orders.handler.js";

const router = Router();

router.post("/api/orders", requireAuth, requireRole(["customer"]), createOrderHandler);

export default router;
