import { deleteSource, getSource, updateSource } from "./controllers.js";
import { allowOwnerOr } from "../../../../middleware/uploadOwner.js";
import mergedTablesRouter from "./merged-tables/index.js";
import relationsRouter from "./relations/index.js";
import transferRouter from "./transfer/index.js";
import { sourceOfParams } from "./middleware.js";
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
sourceRouter.use("/merged-tables", mergedTablesRouter);
sourceRouter.use("/refresh", refreshRouter);
sourceRouter.use("/relations", relationsRouter);
sourceRouter.use("/tables", tablesRouter);
sourceRouter.use("/test", testRouter);
sourceRouter.use("/transfer", transferRouter);

// An upload source's owner reads, renames and deletes their own source.
sourceRouter.get("/", allowOwnerOr(SOURCES_READ, sourceOfParams), getSource);
sourceRouter.patch(
  "/",
  allowOwnerOr(SOURCES_WRITE, sourceOfParams),
  json64k,
  updateSource
);
sourceRouter.delete(
  "/",
  allowOwnerOr(SOURCES_WRITE, sourceOfParams),
  deleteSource
);

export default sourceRouter;
