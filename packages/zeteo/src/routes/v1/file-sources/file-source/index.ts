import transferRouter from "./transfer/index.js";
import tablesRouter from "./tables/index.js";
import express, { Router } from "express";
import {
  deleteFileSource,
  getFileSource,
  updateFileSource,
} from "./controllers.js";

const fileSourceRouter = Router({ mergeParams: true });

const json64k = express.json({ limit: "64kb" });

fileSourceRouter.use("/tables", tablesRouter);
fileSourceRouter.use("/transfer", transferRouter);

fileSourceRouter.get("/", getFileSource);
fileSourceRouter.patch("/", json64k, updateFileSource);
fileSourceRouter.delete("/", deleteFileSource);

export default fileSourceRouter;
