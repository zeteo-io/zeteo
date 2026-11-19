import { SOURCES_READ } from "../../../../../../definitions/tereoDeclaration.js";
import { allowOwnerOr } from "../../../../../../middleware/uploadOwner.js";
import { sourceOfParams } from "../../middleware.js";
import { getMergedColumns } from "./controllers.js";
import { Router } from "express";

const columnsRouter = Router({ mergeParams: true });

columnsRouter.get(
  "/",
  allowOwnerOr(SOURCES_READ, sourceOfParams),
  getMergedColumns
);

export default columnsRouter;
