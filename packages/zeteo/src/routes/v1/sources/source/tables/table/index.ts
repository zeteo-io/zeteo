import { requirePermission } from "../../../../../../middleware/auth.js";
import { getTable, patchTable } from "./controllers.js";
import express, { Router } from "express";
import {
  SOURCES_READ,
  SOURCES_WRITE,
} from "../../../../../../definitions/tereoDeclaration.js";

const tableRouter = Router({ mergeParams: true });

const json64k = express.json({ limit: "64kb" });

tableRouter.get("/", requirePermission(SOURCES_READ), getTable);
tableRouter.patch("/", requirePermission(SOURCES_WRITE), json64k, patchTable);

export default tableRouter;
