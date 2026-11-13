import healthRouter from "./health/index.js";
import v1Router from "./v1/index.js";
import { Router } from "express";

/** Zeteo's URL tree: the API under /v1, /health at the root. */
const router = Router();

router.use("/health", healthRouter);
router.use("/v1", v1Router);

export default router;
