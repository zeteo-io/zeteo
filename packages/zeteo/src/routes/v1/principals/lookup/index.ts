import { lookupPrincipalsHandler } from "./controllers.js";
import { requireLookup } from "./middleware.js";
import express, { Router } from "express";

const principalsLookupRouter = Router();

const json64k = express.json({ limit: "64kb" });

principalsLookupRouter.post(
  "/",
  requireLookup,
  json64k,
  lookupPrincipalsHandler
);

export default principalsLookupRouter;
