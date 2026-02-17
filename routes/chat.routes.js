import { Router } from "express";
import { chatRag } from "../middleware/handlers/chat.handler.js";

const router = Router();

router.post("/chat", chatRag);

export default router;
