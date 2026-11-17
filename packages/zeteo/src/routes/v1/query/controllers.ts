import { serveQuery } from "../../../utils/serveQuery.js";
import { callerOf } from "../../../middleware/auth.js";
import { runQuery } from "../../../engine/index.js";
import type { Request, Response } from "express";

export const postQuery = async (req: Request, res: Response) => {
  await serveQuery(req, res, (signal) =>
    runQuery({
      caller: callerOf(req),
      entryPoint: "api",
      body: req.body,
      signal,
    })
  );
};
