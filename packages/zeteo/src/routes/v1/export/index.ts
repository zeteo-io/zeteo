import { DATA_EXPORT } from "../../../definitions/tereoDeclaration.js";
import { requirePermission } from "../../../middleware/auth.js";
import { postExport } from "./controllers.js";
import express, { Router } from "express";

const exportRouter = Router();

const json64k = express.json({ limit: "64kb" });

exportRouter.post("/", requirePermission(DATA_EXPORT), json64k, postExport);

export default exportRouter;
