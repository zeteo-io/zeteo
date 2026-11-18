import { SOURCES_READ } from "../../../../../definitions/tereoDeclaration.js";
import { allowOwnerOr } from "../../../../../middleware/fileSourceOwner.js";
import { sourceOfParams } from "../middleware.js";
import { listTables } from "./controllers.js";
import tableRouter from "./table/index.js";
import { Router } from "express";

const tablesRouter = Router({ mergeParams: true });

tablesRouter.use("/:tableId", tableRouter);

tablesRouter.get("/", allowOwnerOr(SOURCES_READ, sourceOfParams), listTables);

export default tablesRouter;
