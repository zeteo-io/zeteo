import columnRouter from "./column/index.js";
import { Router } from "express";

const columnsRouter = Router({ mergeParams: true });

columnsRouter.use("/:columnId", columnRouter);

export default columnsRouter;
