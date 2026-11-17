import { DATA_READ } from "../../../definitions/tereoDeclaration.js";
import { createDashboard, listDashboards } from "./controllers.js";
import { requirePermission } from "../../../middleware/auth.js";
import dashboardRouter from "./dashboard/index.js";
import express, { Router } from "express";

const dashboardsRouter = Router();

const json256k = express.json({ limit: "256kb" });

dashboardsRouter.use("/:dashboardId", dashboardRouter);

dashboardsRouter.get("/", requirePermission(DATA_READ), listDashboards);
dashboardsRouter.post(
  "/",
  requirePermission(DATA_READ),
  json256k,
  createDashboard
);

export default dashboardsRouter;
