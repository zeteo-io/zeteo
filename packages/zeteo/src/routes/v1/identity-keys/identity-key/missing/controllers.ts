import { validateParams } from "../../../../../utils/validateReq.js";
import { missingValues } from "../../../../../identity/missing.js";
import { IdentityKeyParamsSchema } from "../schemas.js";
import type { Request, Response } from "express";

export const listMissingValues = async (req: Request, res: Response) => {
  const { keyId } = validateParams(IdentityKeyParamsSchema, req);
  const users = await missingValues(keyId);
  res.setHeader("Cache-Control", "no-store");
  res.status(200).json({ users });
};
