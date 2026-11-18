import { postUpload } from "./controllers.js";
import { Router } from "express";

const uploadsRouter = Router();

uploadsRouter.post("/", postUpload);

export default uploadsRouter;
