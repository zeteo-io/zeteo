import { DATA_READ } from "../../../../../definitions/tereoDeclaration.js";
import { requirePermission } from "../../../../../middleware/auth.js";
import { listShares, replaceShares } from "./controllers.js";
import express, { Router } from "express";

const sharesRouter = Router({ mergeParams: true });

const json64k = express.json({ limit: "64kb" });

sharesRouter.get("/", requirePermission(DATA_READ), listShares);
sharesRouter.put("/", requirePermission(DATA_READ), json64k, replaceShares);

export default sharesRouter;
