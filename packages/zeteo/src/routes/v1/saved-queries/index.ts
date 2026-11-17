import { createSavedQuery, listSavedQueries } from "./controllers.js";
import { DATA_READ } from "../../../definitions/tereoDeclaration.js";
import { requirePermission } from "../../../middleware/auth.js";
import savedQueryRouter from "./saved-query/index.js";
import express, { Router } from "express";

const savedQueriesRouter = Router();

const json256k = express.json({ limit: "256kb" });

savedQueriesRouter.use("/:savedQueryId", savedQueryRouter);

savedQueriesRouter.get("/", requirePermission(DATA_READ), listSavedQueries);
savedQueriesRouter.post(
  "/",
  requirePermission(DATA_READ),
  json256k,
  createSavedQuery
);

export default savedQueriesRouter;
