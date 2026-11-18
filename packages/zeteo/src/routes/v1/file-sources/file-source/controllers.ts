import { validateBody, validateParams } from "../../../../utils/validateReq.js";
import { FileSourceParamsSchema, UpdateFileSourceSchema } from "./schemas.js";
import { callerOf } from "../../../../middleware/auth.js";
import type { Request, Response } from "express";
import {
  deleteFileSource as remove,
  getFileSource as get,
  renameFileSource,
} from "../../../../file-sources/service.js";

export const getFileSource = async (req: Request, res: Response) => {
  const { sourceId } = validateParams(FileSourceParamsSchema, req);
  res.status(200).json(await get(callerOf(req), sourceId));
};

export const updateFileSource = async (req: Request, res: Response) => {
  const { sourceId } = validateParams(FileSourceParamsSchema, req);
  const { name } = validateBody(UpdateFileSourceSchema, req);
  res.status(200).json(await renameFileSource(callerOf(req), sourceId, name));
};

export const deleteFileSource = async (req: Request, res: Response) => {
  const { sourceId } = validateParams(FileSourceParamsSchema, req);
  await remove(callerOf(req), sourceId);
  res.status(204).end();
};
