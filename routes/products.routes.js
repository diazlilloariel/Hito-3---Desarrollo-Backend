import { Router } from "express";
import { requireAuth, requireRole } from "../middlewares.js";
import {
  listProducts,
  productsMeta,
  getProductById,
  createProduct,
  patchProduct,
  deactivateProduct,
} from "../middleware/handlers/products.handler.js";

const router = Router();

router.get("/products", listProducts);
router.get("/products/meta", productsMeta);
router.get("/products/:id", getProductById);

// ops manager
router.post("/products", requireAuth, requireRole(["manager"]), createProduct);
router.patch("/products/:id", requireAuth, requireRole(["manager"]), patchProduct);
router.patch(
  "/products/:id/deactivate",
  requireAuth,
  requireRole(["manager"]),
  deactivateProduct,
);

export default router;
