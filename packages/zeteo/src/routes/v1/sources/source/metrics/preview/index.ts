import { requirePermission } from "../../../../../../middleware/auth.js";
import { previewMetric } from "./controllers.js";
import express, { Router } from "express";
import {
  DATA_READ,
  MEASURES_WRITE,
} from "../../../../../../definitions/tereoDeclaration.js";

const previewRouter = Router({ mergeParams: true });

previewRouter.post(
  "/",
  requirePermission(MEASURES_WRITE),
  requirePermission(DATA_READ),
  express.json({ limit: "64kb" }),
  previewMetric
);

export default previewRouter;
