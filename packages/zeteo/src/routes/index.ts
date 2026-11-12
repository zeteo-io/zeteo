import healthRouter from "./health/index.js";
import { Router } from "express";

/** Zeteo's URL tree: /health stays at the root. */
const router = Router();

router.use("/health", healthRouter);

export default router;
