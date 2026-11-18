import principalLimitsRouter from "./principal-limits/index.js";
import { dropCachedIntrospection } from "./me/middleware.js";
import savedQueriesRouter from "./saved-queries/index.js";
import savedPanelsRouter from "./saved-panels/index.js";
import { authenticate } from "../../middleware/auth.js";
import fileSourcesRouter from "./file-sources/index.js";
import dashboardsRouter from "./dashboards/index.js";
import principalsRouter from "./principals/index.js";
import catalogRouter from "./catalog/index.js";
import sourcesRouter from "./sources/index.js";
import exportRouter from "./export/index.js";
import grantsRouter from "./grants/index.js";
import queryRouter from "./query/index.js";
import runsRouter from "./runs/index.js";
import meRouter from "./me/index.js";
import { Router } from "express";

const v1Router = Router();

v1Router.use("/me", dropCachedIntrospection);
v1Router.use(authenticate);
v1Router.use("/catalog", catalogRouter);
v1Router.use("/dashboards", dashboardsRouter);
v1Router.use("/export", exportRouter);
v1Router.use("/file-sources", fileSourcesRouter);
v1Router.use("/grants", grantsRouter);
v1Router.use("/me", meRouter);
v1Router.use("/principal-limits", principalLimitsRouter);
v1Router.use("/principals", principalsRouter);
v1Router.use("/query", queryRouter);
v1Router.use("/runs", runsRouter);
v1Router.use("/saved-panels", savedPanelsRouter);
v1Router.use("/saved-queries", savedQueriesRouter);
v1Router.use("/sources", sourcesRouter);

export default v1Router;
