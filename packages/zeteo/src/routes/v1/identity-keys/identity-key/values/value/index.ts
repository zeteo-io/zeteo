import { GRANTS_WRITE } from "../../../../../../definitions/tereoDeclaration.js";
import { requirePermission } from "../../../../../../middleware/auth.js";
import { deleteIdentityValue } from "./controllers.js";
import { Router } from "express";

const identityValueRouter = Router({ mergeParams: true });

identityValueRouter.delete(
  "/",
  requirePermission(GRANTS_WRITE),
  deleteIdentityValue
);

export default identityValueRouter;
