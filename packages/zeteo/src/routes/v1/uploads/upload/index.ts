import { deleteUpload } from "./controllers.js";
import { Router } from "express";

const uploadRouter = Router({ mergeParams: true });

uploadRouter.delete("/", deleteUpload);

export default uploadRouter;
