import { validateBody, validateParams } from "../../../../utils/validateReq.js";
import { principalStatuses } from "../../../../grants/principalStatuses.js";
import { GrantParamsSchema, ReplaceGrantSchema } from "./schemas.js";
import { callerOf } from "../../../../middleware/auth.js";
import { grantView } from "../../../../views/grant.js";
import type { Request, Response } from "express";
import {
  getGrant as get,
  removeGrant,
  replaceGrantColumns,
} from "../../../../grants/service.js";

const respond = async (res: Response, row: Awaited<ReturnType<typeof get>>) => {
  const statuses = await principalStatuses([row]);
  res
    .status(200)
    .json(grantView(row, statuses.get(row.principalType, row.principalId)));
};

export const getGrant = async (req: Request, res: Response) => {
  const { grantId } = validateParams(GrantParamsSchema, req);
  await respond(res, await get(grantId));
};

export const replaceGrant = async (req: Request, res: Response) => {
  const { grantId } = validateParams(GrantParamsSchema, req);
  const body = validateBody(ReplaceGrantSchema, req);
  const row = await replaceGrantColumns(
    grantId,
    body.all_columns
      ? { allColumns: true }
      : { allColumns: false, columnIds: body.column_ids },
    callerOf(req).userId
  );
  await respond(res, row);
};

export const deleteGrant = async (req: Request, res: Response) => {
  const { grantId } = validateParams(GrantParamsSchema, req);
  await removeGrant(grantId, callerOf(req).userId);
  res.status(204).end();
};
