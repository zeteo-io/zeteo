import { DATA_READ } from "../../../../definitions/tereoDeclaration.js";
import { requirePermission } from "../../../../middleware/auth.js";
import { listMyRuns } from "./controllers.js";
import { Router } from "express";

const myRunsRouter = Router();

myRunsRouter.get("/", requirePermission(DATA_READ), listMyRuns);

export default myRunsRouter;
