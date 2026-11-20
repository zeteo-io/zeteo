import { GRANTS_WRITE } from "../../../../definitions/tereoDeclaration.js";
import { deleteIdentityKey, updateIdentityKey } from "./controllers.js";
import { requirePermission } from "../../../../middleware/auth.js";
import identityValuesRouter from "./values/index.js";
import express, { Router } from "express";

const identityKeyRouter = Router({ mergeParams: true });

const json64k = express.json({ limit: "64kb" });

identityKeyRouter.use("/values", identityValuesRouter);

identityKeyRouter.patch(
  "/",
  requirePermission(GRANTS_WRITE),
  json64k,
  updateIdentityKey
);
identityKeyRouter.delete(
  "/",
  requirePermission(GRANTS_WRITE),
  deleteIdentityKey
);

export default identityKeyRouter;
