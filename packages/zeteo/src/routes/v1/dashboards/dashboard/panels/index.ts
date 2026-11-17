import { DATA_READ } from "../../../../../definitions/tereoDeclaration.js";
import { requirePermission } from "../../../../../middleware/auth.js";
import { addPanel } from "./controllers.js";
import panelRouter from "./panel/index.js";
import express, { Router } from "express";

const panelsRouter = Router({ mergeParams: true });

const json64k = express.json({ limit: "64kb" });

panelsRouter.use("/:panelId", panelRouter);

panelsRouter.post("/", requirePermission(DATA_READ), json64k, addPanel);

export default panelsRouter;
