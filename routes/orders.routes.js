// routes/orders.routes.js
import { Router } from "express";
import { requireAuth } from "../middleware/requireAuth.js";
import { createOrderHandler } from "../handlers/orders.handler.js";

const router = Router();

router.post("/", requireAuth, createOrderHandler);

export default router;
