import { deleteMetric, getMetric, patchMetric } from "./controllers.js";
import express, { Router } from "express";
import {
  DATA_READ,
  MEASURES_WRITE,
  SOURCES_READ,
} from "../../../../../../definitions/tereoDeclaration.js";
import {
  requireAnyPermission,
  requirePermission,
} from "../../../../../../middleware/auth.js";

const metricRouter = Router({ mergeParams: true });

metricRouter.get(
  "/",
  requireAnyPermission([DATA_READ, SOURCES_READ, MEASURES_WRITE]),
  getMetric
);
metricRouter.patch(
  "/",
  requirePermission(MEASURES_WRITE),
  express.json({ limit: "64kb" }),
  patchMetric
);
metricRouter.delete("/", requirePermission(MEASURES_WRITE), deleteMetric);

export default metricRouter;
