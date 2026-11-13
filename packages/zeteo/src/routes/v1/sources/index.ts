import { requirePermission } from "../../../middleware/auth.js";
import { createSource, listSources } from "./controllers.js";
import sourceRouter from "./source/index.js";
import express, { Router } from "express";
import {
  SOURCES_READ,
  SOURCES_WRITE,
} from "../../../definitions/tereoDeclaration.js";

const sourcesRouter = Router();

const json64k = express.json({ limit: "64kb" });

sourcesRouter.use("/:sourceId", sourceRouter);

sourcesRouter.get("/", requirePermission(SOURCES_READ), listSources);
sourcesRouter.post(
  "/",
  requirePermission(SOURCES_WRITE),
  json64k,
  createSource
);

export default sourcesRouter;
