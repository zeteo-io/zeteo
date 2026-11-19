import { postLink } from "./controllers.js";
import express, { Router } from "express";

const json64k = express.json({ limit: "64kb" });

const linksRouter = Router();

linksRouter.post("/", json64k, postLink);

export default linksRouter;
