import { requirePermission } from "../../../../middleware/auth.js";
import { getSource, updateSource } from "./controllers.js";
import relationsRouter from "./relations/index.js";
import refreshRouter from "./refresh/index.js";
import archiveRouter from "./archive/index.js";
import tablesRouter from "./tables/index.js";
import express, { Router } from "express";
import testRouter from "./test/index.js";
import {
  SOURCES_READ,
  SOURCES_WRITE,
} from "../../../../definitions/tereoDeclaration.js";

const sourceRouter = Router({ mergeParams: true });

const json64k = express.json({ limit: "64kb" });

sourceRouter.use("/archive", archiveRouter);
sourceRouter.use("/refresh", refreshRouter);
sourceRouter.use("/relations", relationsRouter);
sourceRouter.use("/tables", tablesRouter);
sourceRouter.use("/test", testRouter);

sourceRouter.get("/", requirePermission(SOURCES_READ), getSource);
sourceRouter.patch(
  "/",
  requirePermission(SOURCES_WRITE),
  json64k,
  updateSource
);

export default sourceRouter;
