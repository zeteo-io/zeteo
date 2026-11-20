import { addValues, listValues } from "../../../../../identity/service.js";
import { encodeCursor, parseCursor } from "../../../../../utils/cursor.js";
import { identityValueView } from "../../../../../views/identityKey.js";
import { callerOf } from "../../../../../middleware/auth.js";
import { IdentityKeyParamsSchema } from "../schemas.js";
import type { Request, Response } from "express";
import {
  validateBody,
  validateParams,
  validateQuery,
} from "../../../../../utils/validateReq.js";
import {
  AddIdentityValuesSchema,
  IdentityValueCursorSchema,
  ListIdentityValuesQuerySchema,
} from "./schemas.js";

export const listIdentityValues = async (req: Request, res: Response) => {
  const { keyId } = validateParams(IdentityKeyParamsSchema, req);
  const query = validateQuery(ListIdentityValuesQuerySchema, req);
  const cursor =
    query.cursor === undefined
      ? undefined
      : parseCursor(query.cursor, IdentityValueCursorSchema)[0];
  const page = await listValues({
    keyId,
    userId: query.user_id,
    cursor,
    limit: query.limit,
  });
  const last = page.rows.at(-1);
  res.status(200).json({
    data: page.rows.map(identityValueView),
    next_cursor: page.hasMore && last ? encodeCursor([last.id]) : null,
  });
};

export const addIdentityValues = async (req: Request, res: Response) => {
  const { keyId } = validateParams(IdentityKeyParamsSchema, req);
  const body = validateBody(AddIdentityValuesSchema, req);
  const rows = await addValues(
    keyId,
    body.values.map((v) => ({ userId: v.user_id, value: v.value })),
    callerOf(req).userId
  );
  res.status(201).json({ data: rows.map(identityValueView) });
};
