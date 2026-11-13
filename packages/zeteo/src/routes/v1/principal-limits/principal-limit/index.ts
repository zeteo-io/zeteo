import { requirePermission } from "../../../../middleware/auth.js";
import express, { Router } from "express";
import {
  GRANTS_READ,
  GRANTS_WRITE,
} from "../../../../definitions/tereoDeclaration.js";
import {
  deletePrincipalLimit,
  getPrincipalLimit,
  updatePrincipalLimit,
} from "./controllers.js";

const principalLimitRouter = Router({ mergeParams: true });

const json64k = express.json({ limit: "64kb" });

principalLimitRouter.get(
  "/",
  requirePermission(GRANTS_READ),
  getPrincipalLimit
);
principalLimitRouter.patch(
  "/",
  requirePermission(GRANTS_WRITE),
  json64k,
  updatePrincipalLimit
);
principalLimitRouter.delete(
  "/",
  requirePermission(GRANTS_WRITE),
  deletePrincipalLimit
);

export default principalLimitRouter;
