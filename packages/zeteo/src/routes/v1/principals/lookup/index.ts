import { requireAnyPermission } from "../../../../middleware/auth.js";
import { lookupPrincipalsHandler } from "./controllers.js";
import express, { Router } from "express";
import {
  GRANTS_READ,
  RUNS_READ,
} from "../../../../definitions/tereoDeclaration.js";

const principalsLookupRouter = Router();

const json64k = express.json({ limit: "64kb" });

principalsLookupRouter.post(
  "/",
  requireAnyPermission([GRANTS_READ, RUNS_READ]),
  json64k,
  lookupPrincipalsHandler
);

export default principalsLookupRouter;
