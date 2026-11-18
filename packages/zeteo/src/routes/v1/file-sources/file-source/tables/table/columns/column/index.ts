import { updateColumn } from "./controllers.js";
import express, { Router } from "express";

const columnRouter = Router({ mergeParams: true });

const json64k = express.json({ limit: "64kb" });

columnRouter.patch("/", json64k, updateColumn);

export default columnRouter;
