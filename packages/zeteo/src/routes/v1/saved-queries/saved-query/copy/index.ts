import { DATA_READ } from "../../../../../definitions/tereoDeclaration.js";
import { requirePermission } from "../../../../../middleware/auth.js";
import { copySavedQuery } from "./controllers.js";
import express, { Router } from "express";

const copyRouter = Router({ mergeParams: true });

const json64k = express.json({ limit: "64kb" });

copyRouter.post("/", requirePermission(DATA_READ), json64k, copySavedQuery);

export default copyRouter;
