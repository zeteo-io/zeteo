import { DATA_READ } from "../../../../definitions/tereoDeclaration.js";
import { requirePermission } from "../../../../middleware/auth.js";
import transferRouter from "./transfer/index.js";
import previewRouter from "./preview/index.js";
import sharesRouter from "./shares/index.js";
import express, { Router } from "express";
import copyRouter from "./copy/index.js";
import {
  deleteSavedPanel,
  getSavedPanel,
  updateSavedPanel,
} from "./controllers.js";

const savedPanelRouter = Router({ mergeParams: true });

const json256k = express.json({ limit: "256kb" });

savedPanelRouter.use("/copy", copyRouter);
savedPanelRouter.use("/preview", previewRouter);
savedPanelRouter.use("/shares", sharesRouter);
savedPanelRouter.use("/transfer", transferRouter);

savedPanelRouter.get("/", requirePermission(DATA_READ), getSavedPanel);
savedPanelRouter.patch(
  "/",
  requirePermission(DATA_READ),
  json256k,
  updateSavedPanel
);
savedPanelRouter.delete("/", requirePermission(DATA_READ), deleteSavedPanel);

export default savedPanelRouter;
