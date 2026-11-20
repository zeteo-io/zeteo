import { GRANTS_READ } from "../../../../definitions/tereoDeclaration.js";
import { requirePermission } from "../../../../middleware/auth.js";
import { getEffectiveAccess } from "./controllers.js";
import { Router } from "express";

const effectiveRouter = Router();

effectiveRouter.get("/", requirePermission(GRANTS_READ), getEffectiveAccess);

export default effectiveRouter;
