import { deleteMeasure, getMeasure, patchMeasure } from "./controllers.js";
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

const measureRouter = Router({ mergeParams: true });

measureRouter.get(
  "/",
  requireAnyPermission([DATA_READ, SOURCES_READ, MEASURES_WRITE]),
  getMeasure
);
measureRouter.patch(
  "/",
  requirePermission(MEASURES_WRITE),
  express.json({ limit: "64kb" }),
  patchMeasure
);
measureRouter.delete("/", requirePermission(MEASURES_WRITE), deleteMeasure);

export default measureRouter;
