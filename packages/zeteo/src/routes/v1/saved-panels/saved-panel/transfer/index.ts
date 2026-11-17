import { DATA_READ } from "../../../../../definitions/tereoDeclaration.js";
import { requirePermission } from "../../../../../middleware/auth.js";
import { transferSavedPanel } from "./controllers.js";
import express, { Router } from "express";

const transferRouter = Router({ mergeParams: true });

const json64k = express.json({ limit: "64kb" });

transferRouter.post(
  "/",
  requirePermission(DATA_READ),
  json64k,
  transferSavedPanel
);

export default transferRouter;
