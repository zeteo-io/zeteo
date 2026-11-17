import { DATA_READ } from "../../../../../../../definitions/tereoDeclaration.js";
import { requirePermission } from "../../../../../../../middleware/auth.js";
import { detachPanel } from "./controllers.js";
import { Router } from "express";

const detachRouter = Router({ mergeParams: true });

detachRouter.post("/", requirePermission(DATA_READ), detachPanel);

export default detachRouter;
