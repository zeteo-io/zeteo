import { GRANTS_READ } from "../../../definitions/tereoDeclaration.js";
import { createKey, listKeys } from "../../../identity/service.js";
import { hasPermission } from "../../../utils/permissions.js";
import { validateBody } from "../../../utils/validateReq.js";
import { callerOf } from "../../../middleware/auth.js";
import { CreateIdentityKeySchema } from "./schemas.js";
import type { Request, Response } from "express";
import {
  identityKeyNameView,
  identityKeyView,
} from "../../../views/identityKey.js";

export const listIdentityKeys = async (req: Request, res: Response) => {
  const rows = await listKeys();
  const full = hasPermission(callerOf(req).permissions, GRANTS_READ);
  res.status(200).json({
    data: rows.map((row) =>
      full ? identityKeyView(row, row.valueCount) : identityKeyNameView(row)
    ),
    next_cursor: null,
  });
};

export const createIdentityKey = async (req: Request, res: Response) => {
  const body = validateBody(CreateIdentityKeySchema, req);
  const row = await createKey(body, callerOf(req).userId);
  res.status(201).json(identityKeyView(row, 0));
};
