import { SOURCES_WRITE } from "../../../../../definitions/tereoDeclaration.js";
import { allowOwnerOr } from "../../../../../middleware/fileSourceOwner.js";
import { sourceOfParams } from "../middleware.js";
import { transferSource } from "./controllers.js";
import express, { Router } from "express";

const transferRouter = Router({ mergeParams: true });

const json64k = express.json({ limit: "64kb" });

transferRouter.post(
  "/",
  allowOwnerOr(SOURCES_WRITE, sourceOfParams),
  json64k,
  transferSource
);

export default transferRouter;
