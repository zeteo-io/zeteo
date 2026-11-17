import { DASHBOARDS_READ } from "../../../../../definitions/tereoDeclaration.js";
import { requirePermission } from "../../../../../middleware/auth.js";
import { listSavedQueryUses } from "./controllers.js";
import { Router } from "express";

const dashboardsRouter = Router({ mergeParams: true });

dashboardsRouter.get(
  "/",
  requirePermission(DASHBOARDS_READ),
  listSavedQueryUses
);

export default dashboardsRouter;
