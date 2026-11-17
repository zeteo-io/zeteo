import { DATA_READ } from "../../../../../definitions/tereoDeclaration.js";
import { requirePermission } from "../../../../../middleware/auth.js";
import { runSavedQuery } from "./controllers.js";
import express, { Router } from "express";

const runRouter = Router({ mergeParams: true });

const json64k = express.json({ limit: "64kb" });

runRouter.post("/", requirePermission(DATA_READ), json64k, runSavedQuery);

export default runRouter;
