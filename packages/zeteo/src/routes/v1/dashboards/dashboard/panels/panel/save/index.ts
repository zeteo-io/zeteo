import { DATA_READ } from "../../../../../../../definitions/tereoDeclaration.js";
import { requirePermission } from "../../../../../../../middleware/auth.js";
import { saveAsSavedPanel } from "./controllers.js";
import express, { Router } from "express";

const saveRouter = Router({ mergeParams: true });

const json64k = express.json({ limit: "64kb" });

saveRouter.post("/", requirePermission(DATA_READ), json64k, saveAsSavedPanel);

export default saveRouter;
