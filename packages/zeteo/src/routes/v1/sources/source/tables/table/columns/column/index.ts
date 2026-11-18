import { SOURCES_WRITE } from "../../../../../../../../definitions/tereoDeclaration.js";
import { allowOwnerOr } from "../../../../../../../../middleware/uploadOwner.js";
import { sourceOfParams } from "../../../../middleware.js";
import { updateColumn } from "./controllers.js";
import express, { Router } from "express";

const columnRouter = Router({ mergeParams: true });

const json64k = express.json({ limit: "64kb" });

// An upload source only.
columnRouter.patch(
  "/",
  allowOwnerOr(SOURCES_WRITE, sourceOfParams),
  json64k,
  updateColumn
);

export default columnRouter;
