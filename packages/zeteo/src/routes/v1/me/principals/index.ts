import { DATA_READ } from "../../../../definitions/tereoDeclaration.js";
import { requirePermission } from "../../../../middleware/auth.js";
import { limitSearch } from "../../principals/middleware.js";
import { searchMyPrincipals } from "./controllers.js";
import myAllPrincipalsRouter from "./all/index.js";
import { Router } from "express";

const myPrincipalsRouter = Router();

myPrincipalsRouter.use("/all", myAllPrincipalsRouter);

myPrincipalsRouter.get(
  "/",
  requirePermission(DATA_READ),
  limitSearch,
  searchMyPrincipals
);

export default myPrincipalsRouter;
