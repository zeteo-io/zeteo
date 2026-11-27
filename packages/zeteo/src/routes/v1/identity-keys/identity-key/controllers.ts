import { validateBody, validateParams } from "../../../../utils/validateReq.js";
import { IdentityKeyParamsSchema, UpdateIdentityKeySchema } from "./schemas.js";
import { removeKey, updateKey } from "../../../../identity/service.js";
import { identityKeyView } from "../../../../views/identityKey.js";
import { callerOf } from "../../../../middleware/auth.js";
import { prisma } from "../../../../utils/db/prisma.js";
import type { Request, Response } from "express";

export const updateIdentityKey = async (req: Request, res: Response) => {
  const { keyId } = validateParams(IdentityKeyParamsSchema, req);
  const body = validateBody(UpdateIdentityKeySchema, req);
  const row = await updateKey(keyId, body, callerOf(req).userId);
  const valueCount = await prisma.identityValue.count({ where: { keyId } });
  res.status(200).json(identityKeyView(row, valueCount));
};

export const deleteIdentityKey = async (req: Request, res: Response) => {
  const { keyId } = validateParams(IdentityKeyParamsSchema, req);
  await removeKey(keyId, callerOf(req).userId);
  res.status(204).end();
};
