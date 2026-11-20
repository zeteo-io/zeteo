import { effectiveAccess } from "../../../../row-rules/effective.js";
import { validateQuery } from "../../../../utils/validateReq.js";
import { EffectiveAccessQuerySchema } from "./schemas.js";
import type { Request, Response } from "express";

export const getEffectiveAccess = async (req: Request, res: Response) => {
  const query = validateQuery(EffectiveAccessQuerySchema, req);
  const access = await effectiveAccess(
    query.user_id,
    query.table_id,
    query.organization_id ?? null
  );
  res.setHeader("Cache-Control", "no-store");
  res.status(200).json(access);
};
