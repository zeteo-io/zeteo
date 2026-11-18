import { SOURCES_WRITE } from "../../../../../../definitions/tereoDeclaration.js";
import { allowOwnerOr } from "../../../../../../middleware/fileSourceOwner.js";
import { deleteRelation, patchRelation } from "./controllers.js";
import { sourceOfParams } from "../../middleware.js";
import express, { Router } from "express";

const relationRouter = Router({ mergeParams: true });

relationRouter.patch(
  "/",
  allowOwnerOr(SOURCES_WRITE, sourceOfParams),
  express.json({ limit: "64kb" }),
  patchRelation
);
relationRouter.delete(
  "/",
  allowOwnerOr(SOURCES_WRITE, sourceOfParams),
  deleteRelation
);

export default relationRouter;
