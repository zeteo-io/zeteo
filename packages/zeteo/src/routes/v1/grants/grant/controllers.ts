import { validateBody, validateParams } from "../../../../utils/validateReq.js";
import { principalStatuses } from "../../../../grants/principalStatuses.js";
import { GRANTS_WRITE } from "../../../../definitions/tereoDeclaration.js";
import { GrantParamsSchema, ReplaceGrantSchema } from "./schemas.js";
import { hasPermission } from "../../../../utils/permissions.js";
import { callerOf } from "../../../../middleware/auth.js";
import { grantView } from "../../../../views/grant.js";
import type { Request, Response } from "express";
import {
  getGrant as get,
  removeGrant,
  replaceGrantColumns,
} from "../../../../grants/service.js";

/** Who acts: past the route's check without `zeteo.grants.write`, the table's owner. */
const actorOf = (req: Request) => {
  const caller = callerOf(req);
  return hasPermission(caller.permissions, GRANTS_WRITE)
    ? { actorId: caller.userId }
    : { actorId: caller.userId, owner: caller };
};

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
    actorOf(req)
  );
  await respond(res, row);
};

export const deleteGrant = async (req: Request, res: Response) => {
  const { grantId } = validateParams(GrantParamsSchema, req);
  await removeGrant(grantId, actorOf(req));
  res.status(204).end();
};
