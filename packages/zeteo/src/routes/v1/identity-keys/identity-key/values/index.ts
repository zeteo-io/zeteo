import { addIdentityValues, listIdentityValues } from "./controllers.js";
import { requirePermission } from "../../../../../middleware/auth.js";
import identityValueRouter from "./value/index.js";
import express, { Router } from "express";
import {
  GRANTS_READ,
  GRANTS_WRITE,
} from "../../../../../definitions/tereoDeclaration.js";

const identityValuesRouter = Router({ mergeParams: true });

// A call may carry 1,000 values of up to 500 characters.
const json1m = express.json({ limit: "1mb" });

identityValuesRouter.use("/:valueId", identityValueRouter);

identityValuesRouter.get(
  "/",
  requirePermission(GRANTS_READ),
  listIdentityValues
);
identityValuesRouter.post(
  "/",
  requirePermission(GRANTS_WRITE),
  json1m,
  addIdentityValues
);

export default identityValuesRouter;
