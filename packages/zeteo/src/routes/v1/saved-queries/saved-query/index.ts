import { DATA_READ } from "../../../../definitions/tereoDeclaration.js";
import { requirePermission } from "../../../../middleware/auth.js";
import dashboardsRouter from "./dashboards/index.js";
import transferRouter from "./transfer/index.js";
import exportRouter from "./export/index.js";
import sharesRouter from "./shares/index.js";
import express, { Router } from "express";
import copyRouter from "./copy/index.js";
import runRouter from "./run/index.js";
import {
  deleteSavedQuery,
  getSavedQuery,
  updateSavedQuery,
} from "./controllers.js";

const savedQueryRouter = Router({ mergeParams: true });

const json256k = express.json({ limit: "256kb" });

savedQueryRouter.use("/copy", copyRouter);
savedQueryRouter.use("/dashboards", dashboardsRouter);
savedQueryRouter.use("/export", exportRouter);
savedQueryRouter.use("/run", runRouter);
savedQueryRouter.use("/shares", sharesRouter);
savedQueryRouter.use("/transfer", transferRouter);

savedQueryRouter.get("/", requirePermission(DATA_READ), getSavedQuery);
savedQueryRouter.patch(
  "/",
  requirePermission(DATA_READ),
  json256k,
  updateSavedQuery
);
savedQueryRouter.delete("/", requirePermission(DATA_READ), deleteSavedQuery);

export default savedQueryRouter;
