import { createIdentityKey, listIdentityKeys } from "./controllers.js";
import identityKeyRouter from "./identity-key/index.js";
import express, { Router } from "express";
import {
  GRANTS_READ,
  GRANTS_WRITE,
  UPLOADS_WRITE,
} from "../../../definitions/tereoDeclaration.js";
import {
  requireAnyPermission,
  requirePermission,
} from "../../../middleware/auth.js";

const identityKeysRouter = Router();

const json64k = express.json({ limit: "64kb" });

identityKeysRouter.use("/:keyId", identityKeyRouter);

identityKeysRouter.get(
  "/",
  requireAnyPermission([GRANTS_READ, UPLOADS_WRITE]),
  listIdentityKeys
);
identityKeysRouter.post(
  "/",
  requirePermission(GRANTS_WRITE),
  json64k,
  createIdentityKey
);

export default identityKeysRouter;
