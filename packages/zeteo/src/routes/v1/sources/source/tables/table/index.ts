import { allowOwnerOr } from "../../../../../../middleware/fileSourceOwner.js";
import { getTable, patchTable } from "./controllers.js";
import { sourceOfParams } from "../../middleware.js";
import express, { Router } from "express";
import {
  SOURCES_READ,
  SOURCES_WRITE,
} from "../../../../../../definitions/tereoDeclaration.js";

const tableRouter = Router({ mergeParams: true });

const json64k = express.json({ limit: "64kb" });

tableRouter.get("/", allowOwnerOr(SOURCES_READ, sourceOfParams), getTable);
tableRouter.patch(
  "/",
  allowOwnerOr(SOURCES_WRITE, sourceOfParams),
  json64k,
  patchTable
);

export default tableRouter;
