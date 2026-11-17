import myPrincipalsRouter from "./principals/index.js";
import { getMeHandler } from "./controllers.js";
import myRunsRouter from "./runs/index.js";
import { Router } from "express";

const meRouter = Router();

meRouter.use("/runs", myRunsRouter);
meRouter.use("/principals", myPrincipalsRouter);
meRouter.get("/", getMeHandler);

export default meRouter;
