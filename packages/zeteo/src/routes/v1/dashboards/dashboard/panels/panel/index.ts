import { DATA_READ } from "../../../../../../definitions/tereoDeclaration.js";
import { requirePermission } from "../../../../../../middleware/auth.js";
import { removePanel, updatePanel } from "./controllers.js";
import detachRouter from "./detach/index.js";
import express, { Router } from "express";
import saveRouter from "./save/index.js";

const panelRouter = Router({ mergeParams: true });

const json64k = express.json({ limit: "64kb" });

panelRouter.use("/detach", detachRouter);
panelRouter.use("/save", saveRouter);

panelRouter.patch("/", requirePermission(DATA_READ), json64k, updatePanel);
panelRouter.delete("/", requirePermission(DATA_READ), removePanel);

export default panelRouter;
