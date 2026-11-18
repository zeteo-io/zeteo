import { allowOwnerOr } from "../../../../../../middleware/uploadOwner.js";
import { sourceOfParams } from "../../middleware.js";
import columnsRouter from "./columns/index.js";
import express, { Router } from "express";
import {
  SOURCES_READ,
  SOURCES_WRITE,
} from "../../../../../../definitions/tereoDeclaration.js";
import {
  getTable,
  patchTable,
  removeTable,
  reuploadTable,
} from "./controllers.js";

const tableRouter = Router({ mergeParams: true });

const json64k = express.json({ limit: "64kb" });
const json1m = express.json({ limit: "1mb" });

tableRouter.use("/columns", columnsRouter);

tableRouter.get("/", allowOwnerOr(SOURCES_READ, sourceOfParams), getTable);
tableRouter.patch(
  "/",
  allowOwnerOr(SOURCES_WRITE, sourceOfParams),
  json64k,
  patchTable
);

// An upload source only: a new upload of the table, and its removal.
tableRouter.put(
  "/",
  allowOwnerOr(SOURCES_WRITE, sourceOfParams),
  json1m,
  reuploadTable
);
tableRouter.delete(
  "/",
  allowOwnerOr(SOURCES_WRITE, sourceOfParams),
  removeTable
);

export default tableRouter;
