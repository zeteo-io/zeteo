import { SOURCES_READ } from "../../../../../definitions/tereoDeclaration.js";
import { requirePermission } from "../../../../../middleware/auth.js";
import { listTables } from "./controllers.js";
import tableRouter from "./table/index.js";
import { Router } from "express";

const tablesRouter = Router({ mergeParams: true });

tablesRouter.use("/:tableId", tableRouter);

tablesRouter.get("/", requirePermission(SOURCES_READ), listTables);

export default tablesRouter;
