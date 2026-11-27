import { GRANTS_READ } from "../../../../../definitions/tereoDeclaration.js";
import { requirePermission } from "../../../../../middleware/auth.js";
import { listMissingValues } from "./controllers.js";
import { Router } from "express";

const missingValuesRouter = Router({ mergeParams: true });

missingValuesRouter.get("/", requirePermission(GRANTS_READ), listMissingValues);

export default missingValuesRouter;
