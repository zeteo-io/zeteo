import { getMetrics, postMetric } from "./controllers.js";
import previewRouter from "./preview/index.js";
import metricRouter from "./metric/index.js";
import express, { Router } from "express";
import {
  DATA_READ,
  MEASURES_WRITE,
  SOURCES_READ,
} from "../../../../../definitions/tereoDeclaration.js";
import {
  requireAnyPermission,
  requirePermission,
} from "../../../../../middleware/auth.js";

const metricsRouter = Router({ mergeParams: true });

const json64k = express.json({ limit: "64kb" });

metricsRouter.use("/preview", previewRouter);
metricsRouter.use("/:metricId", metricRouter);

// Each caller sees the metrics they may; editors also those they may not use, redacted.
metricsRouter.get(
  "/",
  requireAnyPermission([DATA_READ, SOURCES_READ, MEASURES_WRITE]),
  getMetrics
);
metricsRouter.post("/", requirePermission(MEASURES_WRITE), json64k, postMetric);

export default metricsRouter;
