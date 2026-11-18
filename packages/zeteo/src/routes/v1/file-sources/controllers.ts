import { validateBody, validateQuery } from "../../../utils/validateReq.js";
import { callerOf } from "../../../middleware/auth.js";
import type { Request, Response } from "express";
import {
  createFileSource as create,
  listFileSources as list,
} from "../../../file-sources/service.js";
import {
  CreateFileSourceSchema,
  ListFileSourcesQuerySchema,
} from "./schemas.js";

export const listFileSources = async (req: Request, res: Response) => {
  const { scope } = validateQuery(ListFileSourcesQuerySchema, req);
  res.status(200).json({ data: await list(callerOf(req), scope) });
};

export const createFileSource = async (req: Request, res: Response) => {
  const body = validateBody(CreateFileSourceSchema, req);
  res.status(201).json(await create(callerOf(req), body));
};
