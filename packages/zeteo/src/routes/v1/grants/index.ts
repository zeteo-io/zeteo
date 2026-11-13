import { requirePermission } from "../../../middleware/auth.js";
import { createGrant, listGrants } from "./controllers.js";
import grantRouter from "./grant/index.js";
import express, { Router } from "express";
import {
  GRANTS_READ,
  GRANTS_WRITE,
} from "../../../definitions/tereoDeclaration.js";

const grantsRouter = Router();

const json64k = express.json({ limit: "64kb" });

grantsRouter.use("/:grantId", grantRouter);

grantsRouter.get("/", requirePermission(GRANTS_READ), listGrants);
grantsRouter.post("/", requirePermission(GRANTS_WRITE), json64k, createGrant);

export default grantsRouter;
