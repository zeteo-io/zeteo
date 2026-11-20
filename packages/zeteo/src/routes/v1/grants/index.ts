import { sourceOfBodyTable, sourceOfListQuery } from "./middleware.js";
import { allowOwnerOr } from "../../../middleware/uploadOwner.js";
import { createGrant, listGrants } from "./controllers.js";
import effectiveRouter from "./effective/index.js";
import grantRouter from "./grant/index.js";
import express, { Router } from "express";
import {
  GRANTS_READ,
  GRANTS_WRITE,
} from "../../../definitions/tereoDeclaration.js";

const grantsRouter = Router();

const json64k = express.json({ limit: "64kb" });

grantsRouter.use("/effective", effectiveRouter);
grantsRouter.use("/:grantId", grantRouter);

// An upload source's owner may list and create grants on its tables.
grantsRouter.get("/", allowOwnerOr(GRANTS_READ, sourceOfListQuery), listGrants);
grantsRouter.post(
  "/",
  allowOwnerOr(GRANTS_WRITE),
  json64k,
  allowOwnerOr(GRANTS_WRITE, sourceOfBodyTable),
  createGrant
);

export default grantsRouter;
