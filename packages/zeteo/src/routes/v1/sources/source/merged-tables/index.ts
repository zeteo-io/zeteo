import { SOURCES_WRITE } from "../../../../../definitions/tereoDeclaration.js";
import { allowOwnerOr } from "../../../../../middleware/uploadOwner.js";
import { createMergedTable } from "./controllers.js";
import { sourceOfParams } from "../middleware.js";
import columnsRouter from "./columns/index.js";
import express, { Router } from "express";

const mergedTablesRouter = Router({ mergeParams: true });

const json1m = express.json({ limit: "1mb" });

mergedTablesRouter.use("/columns", columnsRouter);

// An upload source only: its owner or an admin merges its tables.
mergedTablesRouter.post(
  "/",
  allowOwnerOr(SOURCES_WRITE, sourceOfParams),
  json1m,
  createMergedTable
);

export default mergedTablesRouter;
