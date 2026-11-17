import { DATA_READ } from "../../../../../definitions/tereoDeclaration.js";
import { requirePermission } from "../../../../../middleware/auth.js";
import { runDashboard } from "./controllers.js";
import express, { Router } from "express";

const runRouter = Router({ mergeParams: true });

const json16k = express.json({ limit: "16kb" });

runRouter.post("/", requirePermission(DATA_READ), json16k, runDashboard);

export default runRouter;
