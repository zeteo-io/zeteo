import { DATA_READ } from "../../../../../definitions/tereoDeclaration.js";
import { requirePermission } from "../../../../../middleware/auth.js";
import { limitSearch } from "../../../principals/middleware.js";
import { listAllMyPrincipals } from "./controllers.js";
import { Router } from "express";

const myAllPrincipalsRouter = Router();

myAllPrincipalsRouter.get(
  "/",
  requirePermission(DATA_READ),
  limitSearch,
  listAllMyPrincipals
);

export default myAllPrincipalsRouter;
