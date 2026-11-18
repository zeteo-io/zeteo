import { createFileSource, listFileSources } from "./controllers.js";
import fileSourceRouter from "./file-source/index.js";
import uploadsRouter from "./uploads/index.js";
import express, { Router } from "express";
import {
  requireFileSources,
  requireFileSourcesManage,
  requireFileSourcesWrite,
} from "./middleware.js";

const fileSourcesRouter = Router();

const json1m = express.json({ limit: "1mb" });

fileSourcesRouter.use(requireFileSources);
fileSourcesRouter.use("/uploads", requireFileSourcesWrite, uploadsRouter);
fileSourcesRouter.use("/:sourceId", requireFileSourcesManage, fileSourceRouter);

fileSourcesRouter.get("/", requireFileSourcesManage, listFileSources);
fileSourcesRouter.post("/", requireFileSourcesWrite, json1m, createFileSource);

export default fileSourcesRouter;
