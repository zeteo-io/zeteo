import { requireUploads } from "./middleware.js";
import { postUpload } from "./controllers.js";
import uploadRouter from "./upload/index.js";
import { Router } from "express";

const uploadsRouter = Router();

uploadsRouter.use(requireUploads);
uploadsRouter.use("/:uploadId", uploadRouter);

uploadsRouter.post("/", postUpload);

export default uploadsRouter;
