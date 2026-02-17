import { Router } from "express";
import { listCategories } from "../middleware/handlers/categories.handler.js";

const router = Router();

// ✅ sin /api (porque app.js monta /api)
router.get("/categories", listCategories);

export default router;
