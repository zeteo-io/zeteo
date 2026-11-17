import { DATA_READ } from "../../../../definitions/tereoDeclaration.js";
import { requirePermission } from "../../../../middleware/auth.js";
import transferRouter from "./transfer/index.js";
import sharesRouter from "./shares/index.js";
import panelsRouter from "./panels/index.js";
import express, { Router } from "express";
import copyRouter from "./copy/index.js";
import runRouter from "./run/index.js";
import {
  deleteDashboard,
  getDashboard,
  updateDashboard,
} from "./controllers.js";

const dashboardRouter = Router({ mergeParams: true });

const json256k = express.json({ limit: "256kb" });

dashboardRouter.use("/copy", copyRouter);
dashboardRouter.use("/panels", panelsRouter);
dashboardRouter.use("/run", runRouter);
dashboardRouter.use("/shares", sharesRouter);
dashboardRouter.use("/transfer", transferRouter);

dashboardRouter.get("/", requirePermission(DATA_READ), getDashboard);
dashboardRouter.patch(
  "/",
  requirePermission(DATA_READ),
  json256k,
  updateDashboard
);
dashboardRouter.delete("/", requirePermission(DATA_READ), deleteDashboard);

export default dashboardRouter;
