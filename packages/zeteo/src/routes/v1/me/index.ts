import { getMeHandler } from "./controllers.js";
import { Router } from "express";

const meRouter = Router();

meRouter.get("/", getMeHandler);

export default meRouter;
