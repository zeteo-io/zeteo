import { SOURCES_WRITE } from "../../../../../../definitions/tereoDeclaration.js";
import { requirePermission } from "../../../../../../middleware/auth.js";
import { deleteRelation, patchRelation } from "./controllers.js";
import express, { Router } from "express";

const relationRouter = Router({ mergeParams: true });

relationRouter.patch(
  "/",
  requirePermission(SOURCES_WRITE),
  express.json({ limit: "64kb" }),
  patchRelation
);
relationRouter.delete("/", requirePermission(SOURCES_WRITE), deleteRelation);

export default relationRouter;
