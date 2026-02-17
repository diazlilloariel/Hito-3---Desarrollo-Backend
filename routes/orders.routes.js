import { Router } from "express";
import { requireAuth, requireRole } from "../middlewares.js";
import {
  createOrder,
  myOrders,
  ordersMeta,
  listOrders,
  getOrderById,
  updateOrderStatus,
  sweepExpiredOrders,
} from "../middleware/handlers/orders.handler.js";

const router = Router();

// customer
router.post("/orders", requireAuth, requireRole(["customer"]), createOrder);
router.get("/orders/me", requireAuth, requireRole(["customer"]), myOrders);

// staff/manager
router.get("/orders/meta", requireAuth, requireRole(["staff", "manager"]), ordersMeta);
router.get("/orders", requireAuth, requireRole(["staff", "manager"]), listOrders);
router.get("/orders/:id", requireAuth, requireRole(["staff", "manager"]), getOrderById);
router.patch("/orders/:id/status", requireAuth, requireRole(["staff", "manager"]), updateOrderStatus);

// manager
router.post("/orders/sweep-expired", requireAuth, requireRole(["manager"]), sweepExpiredOrders);

export default router;
