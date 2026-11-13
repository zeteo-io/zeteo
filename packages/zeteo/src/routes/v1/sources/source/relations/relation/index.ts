import { SOURCES_WRITE } from "../../../../../../definitions/tereoDeclaration.js";
import { requirePermission } from "../../../../../../middleware/auth.js";
import { deleteRelation } from "./controllers.js";
import { Router } from "express";

const relationRouter = Router({ mergeParams: true });

relationRouter.delete("/", requirePermission(SOURCES_WRITE), deleteRelation);

export default relationRouter;
