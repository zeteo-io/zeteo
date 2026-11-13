import { authenticate } from "../../middleware/auth.js";
import sourcesRouter from "./sources/index.js";
import grantsRouter from "./grants/index.js";
import { Router } from "express";

const v1Router = Router();

v1Router.use(authenticate);
v1Router.use("/grants", grantsRouter);
v1Router.use("/sources", sourcesRouter);

export default v1Router;
