import { removeTable, reuploadTable } from "./controllers.js";
import columnsRouter from "./columns/index.js";
import express, { Router } from "express";

const tableRouter = Router({ mergeParams: true });

const json1m = express.json({ limit: "1mb" });

tableRouter.use("/columns", columnsRouter);

tableRouter.put("/", json1m, reuploadTable);
tableRouter.delete("/", removeTable);

export default tableRouter;
