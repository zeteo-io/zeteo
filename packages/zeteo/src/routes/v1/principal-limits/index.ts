import { createPrincipalLimit, listPrincipalLimits } from "./controllers.js";
import { requirePermission } from "../../../middleware/auth.js";
import principalLimitRouter from "./principal-limit/index.js";
import express, { Router } from "express";
import {
  GRANTS_READ,
  GRANTS_WRITE,
} from "../../../definitions/tereoDeclaration.js";

const principalLimitsRouter = Router();

const json64k = express.json({ limit: "64kb" });

principalLimitsRouter.use("/:principalLimitId", principalLimitRouter);

principalLimitsRouter.get(
  "/",
  requirePermission(GRANTS_READ),
  listPrincipalLimits
);
principalLimitsRouter.post(
  "/",
  requirePermission(GRANTS_WRITE),
  json64k,
  createPrincipalLimit
);

export default principalLimitsRouter;
