import principalLimitsRouter from "./principal-limits/index.js";
import { authenticate } from "../../middleware/auth.js";
import principalsRouter from "./principals/index.js";
import catalogRouter from "./catalog/index.js";
import sourcesRouter from "./sources/index.js";
import exportRouter from "./export/index.js";
import grantsRouter from "./grants/index.js";
import queryRouter from "./query/index.js";
import runsRouter from "./runs/index.js";
import { Router } from "express";

const v1Router = Router();

v1Router.use(authenticate);
v1Router.use("/catalog", catalogRouter);
v1Router.use("/export", exportRouter);
v1Router.use("/grants", grantsRouter);
v1Router.use("/principal-limits", principalLimitsRouter);
v1Router.use("/principals", principalsRouter);
v1Router.use("/query", queryRouter);
v1Router.use("/runs", runsRouter);
v1Router.use("/sources", sourcesRouter);

export default v1Router;
