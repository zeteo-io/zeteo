import { addTables } from "./controllers.js";
import tableRouter from "./table/index.js";
import express, { Router } from "express";

const tablesRouter = Router({ mergeParams: true });

const json1m = express.json({ limit: "1mb" });

tablesRouter.use("/:tableId", tableRouter);

tablesRouter.post("/", json1m, addTables);

export default tablesRouter;
