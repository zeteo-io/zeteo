import { DATA_READ } from "../../../../../../definitions/tereoDeclaration.js";
import { requirePermission } from "../../../../../../middleware/auth.js";
import { removePanel, updatePanel } from "./controllers.js";
import express, { Router } from "express";

const panelRouter = Router({ mergeParams: true });

const json64k = express.json({ limit: "64kb" });

panelRouter.patch("/", requirePermission(DATA_READ), json64k, updatePanel);
panelRouter.delete("/", requirePermission(DATA_READ), removePanel);

export default panelRouter;
