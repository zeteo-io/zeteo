import { requireCreating, requireListing } from "./middleware.js";
import { createSource, listSources } from "./controllers.js";
import sourceRouter from "./source/index.js";
import express, { Router } from "express";

const sourcesRouter = Router();

// An upload source's create carries its tables' corrections.
const json1m = express.json({ limit: "1mb" });

sourcesRouter.use("/:sourceId", sourceRouter);

sourcesRouter.get("/", requireListing, listSources);
sourcesRouter.post("/", requireCreating, json1m, createSource);

export default sourcesRouter;
