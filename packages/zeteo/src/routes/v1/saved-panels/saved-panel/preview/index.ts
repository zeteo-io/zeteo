import { DATA_READ } from "../../../../../definitions/tereoDeclaration.js";
import { requirePermission } from "../../../../../middleware/auth.js";
import { previewSavedPanel } from "./controllers.js";
import express, { Router } from "express";

const previewRouter = Router({ mergeParams: true });

const json64k = express.json({ limit: "64kb" });

previewRouter.post(
  "/",
  requirePermission(DATA_READ),
  json64k,
  previewSavedPanel
);

export default previewRouter;
