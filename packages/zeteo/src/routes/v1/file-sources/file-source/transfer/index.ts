import { transferFileSource } from "./controllers.js";
import express, { Router } from "express";

const transferRouter = Router({ mergeParams: true });

const json64k = express.json({ limit: "64kb" });

transferRouter.post("/", json64k, transferFileSource);

export default transferRouter;
