import { SOURCES_WRITE } from "../../../../../definitions/tereoDeclaration.js";
import { requirePermission } from "../../../../../middleware/auth.js";
import { archiveSource } from "./controllers.js";
import { Router } from "express";

const archiveRouter = Router({ mergeParams: true });

archiveRouter.post("/", requirePermission(SOURCES_WRITE), archiveSource);

export default archiveRouter;
