import { requireFileSources } from "./middleware.js";
import uploadsRouter from "./uploads/index.js";
import { Router } from "express";

const fileSourcesRouter = Router();

fileSourcesRouter.use(requireFileSources);
fileSourcesRouter.use("/uploads", uploadsRouter);

export default fileSourcesRouter;
