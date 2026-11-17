import { DATA_EXPORT } from "../../../../../definitions/tereoDeclaration.js";
import { requirePermission } from "../../../../../middleware/auth.js";
import { exportSavedQuery } from "./controllers.js";
import express, { Router } from "express";

const exportRouter = Router({ mergeParams: true });

const json64k = express.json({ limit: "64kb" });

exportRouter.post(
  "/",
  requirePermission(DATA_EXPORT),
  json64k,
  exportSavedQuery
);

export default exportRouter;
