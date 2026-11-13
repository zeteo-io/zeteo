import { DATA_READ } from "../../../definitions/tereoDeclaration.js";
import { requirePermission } from "../../../middleware/auth.js";
import { getCatalog } from "./controllers.js";
import { Router } from "express";

const catalogRouter = Router();

catalogRouter.get("/", requirePermission(DATA_READ), getCatalog);

export default catalogRouter;
