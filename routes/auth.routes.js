import { Router } from "express";
import {
  register,
  login,
  verifyPassword,
} from "../middleware/handlers/auth.handler.js";
import { requireAuth, requireRole } from "../middlewares.js";

const router = Router();

router.post("/auth/register", register);
router.post("/auth/login", login);
router.post("/auth/verify-password", requireAuth, requireRole(["manager"]), verifyPassword);

export default router;
