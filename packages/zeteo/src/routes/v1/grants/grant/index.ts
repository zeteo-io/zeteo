import { deleteGrant, getGrant, replaceGrant } from "./controllers.js";
import { requirePermission } from "../../../../middleware/auth.js";
import express, { Router } from "express";
import {
  GRANTS_READ,
  GRANTS_WRITE,
} from "../../../../definitions/tereoDeclaration.js";

const grantRouter = Router({ mergeParams: true });

const json64k = express.json({ limit: "64kb" });

grantRouter.get("/", requirePermission(GRANTS_READ), getGrant);
grantRouter.put("/", requirePermission(GRANTS_WRITE), json64k, replaceGrant);
grantRouter.delete("/", requirePermission(GRANTS_WRITE), deleteGrant);

export default grantRouter;
