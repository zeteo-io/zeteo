import { SOURCES_WRITE } from "../../../../../definitions/tereoDeclaration.js";
import { requirePermission } from "../../../../../middleware/auth.js";
import { testSource } from "./controllers.js";
import { Router } from "express";

const testRouter = Router({ mergeParams: true });

testRouter.post("/", requirePermission(SOURCES_WRITE), testSource);

export default testRouter;
