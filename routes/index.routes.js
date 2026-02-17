import { Router } from "express";

import ordersRoutes from "./orders.routes.js";

// (los crearás después)
import healthRoutes from "./health.routes.js";
import authRoutes from "./auth.routes.js";
import productsRoutes from "./products.routes.js";
import categoriesRoutes from "./categories.routes.js";
import inventoryRoutes from "./inventory.routes.js";
import chatRoutes from "./chat.routes.js";

const router = Router();

// Montaje por dominio
router.use(healthRoutes);
router.use(authRoutes);
router.use(productsRoutes);
router.use(categoriesRoutes);
router.use(inventoryRoutes);
router.use(ordersRoutes);
router.use(chatRoutes);

export default router;