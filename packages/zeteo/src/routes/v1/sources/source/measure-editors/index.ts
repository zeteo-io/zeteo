import { requireAnyPermission } from "../../../../../middleware/auth.js";
import { allowOwnerOr } from "../../../../../middleware/uploadOwner.js";
import { getEditors, putEditors } from "./controllers.js";
import { sourceOfParams } from "../middleware.js";
import express, { Router } from "express";
import {
  MEASURES_WRITE,
  SOURCES_WRITE,
  UPLOADS_WRITE,
} from "../../../../../definitions/tereoDeclaration.js";

const measureEditorsRouter = Router({ mergeParams: true });

// Read by those who manage the list and by the editors on it.
measureEditorsRouter.get(
  "/",
  requireAnyPermission([SOURCES_WRITE, MEASURES_WRITE, UPLOADS_WRITE]),
  getEditors
);
// Replaced by `zeteo.sources.write` holders and an upload source's owner.
measureEditorsRouter.put(
  "/",
  allowOwnerOr(SOURCES_WRITE, sourceOfParams),
  express.json({ limit: "64kb" }),
  putEditors
);

export default measureEditorsRouter;
