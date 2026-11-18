import { allowOwnerOr } from "../../../../../middleware/uploadOwner.js";
import { addTables, listTables } from "./controllers.js";
import { sourceOfParams } from "../middleware.js";
import tableRouter from "./table/index.js";
import express, { Router } from "express";
import {
  SOURCES_READ,
  SOURCES_WRITE,
} from "../../../../../definitions/tereoDeclaration.js";

const tablesRouter = Router({ mergeParams: true });

const json1m = express.json({ limit: "1mb" });

tablesRouter.use("/:tableId", tableRouter);

tablesRouter.get("/", allowOwnerOr(SOURCES_READ, sourceOfParams), listTables);
// An upload source only: tables from a staging.
tablesRouter.post(
  "/",
  allowOwnerOr(SOURCES_WRITE, sourceOfParams),
  json1m,
  addTables
);

export default tablesRouter;
