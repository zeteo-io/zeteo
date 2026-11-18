import googleRouter from "./google/index.js";
import { Router } from "express";

const connectionsRouter = Router();

connectionsRouter.use("/google", googleRouter);

export default connectionsRouter;
