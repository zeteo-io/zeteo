import { DATA_READ } from "../../../definitions/tereoDeclaration.js";
import { requirePermission } from "../../../middleware/auth.js";
import { postQuery } from "./controllers.js";
import express, { Router } from "express";

const queryRouter = Router();

const json64k = express.json({ limit: "64kb" });

queryRouter.post("/", requirePermission(DATA_READ), json64k, postQuery);

export default queryRouter;
