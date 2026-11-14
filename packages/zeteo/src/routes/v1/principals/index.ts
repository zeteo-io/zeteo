import { GRANTS_READ } from "../../../definitions/tereoDeclaration.js";
import { requirePermission } from "../../../middleware/auth.js";
import { searchPrincipalsHandler } from "./controllers.js";
import principalsLookupRouter from "./lookup/index.js";
import { limitSearch } from "./middleware.js";
import { Router } from "express";

const principalsRouter = Router();

principalsRouter.use("/lookup", principalsLookupRouter);

principalsRouter.get(
  "/",
  requirePermission(GRANTS_READ),
  limitSearch,
  searchPrincipalsHandler
);

export default principalsRouter;
