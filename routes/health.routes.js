import { Router } from "express";
import { healthCheck } from "../middleware/handlers/health.handler.js";

const router = Router();
router.get("/health", healthCheck);
export default router;
