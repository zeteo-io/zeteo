import { allowOwnerOr } from "../../../../../middleware/fileSourceOwner.js";
import { declareRelation, listRelations } from "./controllers.js";
import { sourceOfParams } from "../middleware.js";
import relationRouter from "./relation/index.js";
import express, { Router } from "express";
import {
  SOURCES_READ,
  SOURCES_WRITE,
} from "../../../../../definitions/tereoDeclaration.js";

const relationsRouter = Router({ mergeParams: true });

const json64k = express.json({ limit: "64kb" });

relationsRouter.use("/:relationId", relationRouter);

relationsRouter.get(
  "/",
  allowOwnerOr(SOURCES_READ, sourceOfParams),
  listRelations
);
relationsRouter.post(
  "/",
  allowOwnerOr(SOURCES_WRITE, sourceOfParams),
  json64k,
  declareRelation
);

export default relationsRouter;
