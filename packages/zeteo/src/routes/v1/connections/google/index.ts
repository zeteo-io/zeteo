import { getGoogleConnection, putGoogle } from "./controllers.js";
import express, { Router } from "express";
import {
  SOURCES_READ,
  SOURCES_WRITE,
  UPLOADS_WRITE,
} from "../../../../definitions/tereoDeclaration.js";
import {
  requireAnyPermission,
  requirePermission,
} from "../../../../middleware/auth.js";

const googleRouter = Router();
const json64k = express.json({ limit: "64kb" });

// Uploaders read the service account's email, to share a sheet with it.
googleRouter.get(
  "/",
  requireAnyPermission([SOURCES_READ, UPLOADS_WRITE]),
  getGoogleConnection
);
googleRouter.put("/", requirePermission(SOURCES_WRITE), json64k, putGoogle);

export default googleRouter;
