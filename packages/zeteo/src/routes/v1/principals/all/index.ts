import { GRANTS_READ } from "../../../../definitions/tereoDeclaration.js";
import { requirePermission } from "../../../../middleware/auth.js";
import { listAllPrincipalsHandler } from "./controllers.js";
import { limitSearch } from "../middleware.js";
import { Router } from "express";

const allPrincipalsRouter = Router();

allPrincipalsRouter.get(
  "/",
  requirePermission(GRANTS_READ),
  limitSearch,
  listAllPrincipalsHandler
);

export default allPrincipalsRouter;
