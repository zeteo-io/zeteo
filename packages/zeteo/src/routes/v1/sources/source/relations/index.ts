import { requirePermission } from "../../../../../middleware/auth.js";
import { declareRelation, listRelations } from "./controllers.js";
import relationRouter from "./relation/index.js";
import express, { Router } from "express";
import {
  SOURCES_READ,
  SOURCES_WRITE,
} from "../../../../../definitions/tereoDeclaration.js";

const relationsRouter = Router({ mergeParams: true });

const json64k = express.json({ limit: "64kb" });

relationsRouter.use("/:relationId", relationRouter);

relationsRouter.get("/", requirePermission(SOURCES_READ), listRelations);
relationsRouter.post(
  "/",
  requirePermission(SOURCES_WRITE),
  json64k,
  declareRelation
);

export default relationsRouter;
