import { getMeasures, postMeasure } from "./controllers.js";
import measureRouter from "./measure/index.js";
import previewRouter from "./preview/index.js";
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

const measuresRouter = Router({ mergeParams: true });

const json64k = express.json({ limit: "64kb" });

measuresRouter.use("/preview", previewRouter);
measuresRouter.use("/:measureId", measureRouter);

// Each caller sees the measures they may; editors also those they may not use, redacted.
measuresRouter.get(
  "/",
  requireAnyPermission([DATA_READ, SOURCES_READ, MEASURES_WRITE]),
  getMeasures
);
measuresRouter.post(
  "/",
  requirePermission(MEASURES_WRITE),
  json64k,
  postMeasure
);

export default measuresRouter;
