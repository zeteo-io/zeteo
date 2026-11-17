import { createSavedPanel, listSavedPanels } from "./controllers.js";
import { DATA_READ } from "../../../definitions/tereoDeclaration.js";
import { requirePermission } from "../../../middleware/auth.js";
import savedPanelRouter from "./saved-panel/index.js";
import express, { Router } from "express";

const savedPanelsRouter = Router();

const json256k = express.json({ limit: "256kb" });

savedPanelsRouter.use("/:savedPanelId", savedPanelRouter);

savedPanelsRouter.get("/", requirePermission(DATA_READ), listSavedPanels);
savedPanelsRouter.post(
  "/",
  requirePermission(DATA_READ),
  json256k,
  createSavedPanel
);

export default savedPanelsRouter;
