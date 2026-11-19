import { SOURCES_WRITE } from "../../../../../../../definitions/tereoDeclaration.js";
import { allowOwnerOr } from "../../../../../../../middleware/uploadOwner.js";
import { sourceOfParams } from "../../../middleware.js";
import { putMergedTable } from "./controllers.js";
import express, { Router } from "express";

const mergedRouter = Router({ mergeParams: true });

const json1m = express.json({ limit: "1mb" });

mergedRouter.put(
  "/",
  allowOwnerOr(SOURCES_WRITE, sourceOfParams),
  json1m,
  putMergedTable
);

export default mergedRouter;
