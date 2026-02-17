import { Router } from "express";
import { requireAuth, requireRole } from "../middlewares.js";
import {
  patchInventory,
  listInventory,
} from "../middleware/handlers/inventory.handler.js";

const router = Router();

router.patch(
  "/inventory/:productId",
  requireAuth,
  requireRole(["staff", "manager"]),
  patchInventory,
);

router.get(
  "/inventory",
  requireAuth,
  requireRole(["staff", "manager"]),
  listInventory,
);

export default router;
