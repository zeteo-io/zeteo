import { testSource as test } from "../../../../../sources/service.js";
import { validateParams } from "../../../../../utils/validateReq.js";
import { SourceParamsSchema } from "../schemas.js";
import type { Request, Response } from "express";

export const testSource = async (req: Request, res: Response) => {
  const { sourceId } = validateParams(SourceParamsSchema, req);
  res.status(200).json({ ok: true, findings: await test(sourceId) });
};
