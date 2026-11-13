import { RUNS_READ } from "../../../definitions/tereoDeclaration.js";
import { requirePermission } from "../../../middleware/auth.js";
import { listRuns } from "./controllers.js";
import { Router } from "express";

const runsRouter = Router();

runsRouter.get("/", requirePermission(RUNS_READ), listRuns);

export default runsRouter;
