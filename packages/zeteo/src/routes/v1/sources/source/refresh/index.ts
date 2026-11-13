import { SOURCES_WRITE } from "../../../../../definitions/tereoDeclaration.js";
import { requirePermission } from "../../../../../middleware/auth.js";
import { refreshSource } from "./controllers.js";
import { Router } from "express";

const refreshRouter = Router({ mergeParams: true });

refreshRouter.post("/", requirePermission(SOURCES_WRITE), refreshSource);

export default refreshRouter;
