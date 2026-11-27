import { validateParams } from "../../../../../../utils/validateReq.js";
import { removeValue } from "../../../../../../identity/service.js";
import { callerOf } from "../../../../../../middleware/auth.js";
import { IdentityValueParamsSchema } from "./schemas.js";
import type { Request, Response } from "express";

export const deleteIdentityValue = async (req: Request, res: Response) => {
  const { keyId, valueId } = validateParams(IdentityValueParamsSchema, req);
  await removeValue(keyId, valueId, callerOf(req).userId);
  res.status(204).end();
};
