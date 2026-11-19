import { SOURCES_WRITE } from "../../../../../definitions/tereoDeclaration.js";
import { allowOwnerOr } from "../../../../../middleware/uploadOwner.js";
import { sourceOfParams } from "../middleware.js";
import { refreshSource } from "./controllers.js";
import { Router } from "express";

const refreshRouter = Router({ mergeParams: true });

// A Google Sheets source's owner syncs their own source (Sync now).
refreshRouter.post(
  "/",
  allowOwnerOr(SOURCES_WRITE, sourceOfParams),
  refreshSource
);

export default refreshRouter;
