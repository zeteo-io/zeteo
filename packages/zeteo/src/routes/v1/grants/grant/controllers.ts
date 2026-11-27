import { validateBody, validateParams } from "../../../../utils/validateReq.js";
import { principalStatuses } from "../../../../grants/principalStatuses.js";
import { GRANTS_WRITE } from "../../../../definitions/tereoDeclaration.js";
import { GrantParamsSchema, ReplaceGrantSchema } from "./schemas.js";
import { hasPermission } from "../../../../utils/permissions.js";
import type { RuleFilter } from "../../../../row-rules/types.js";
import { ruleNamesFor } from "../../../../row-rules/store.js";
import { callerOf } from "../../../../middleware/auth.js";
import { grantView } from "../../../../views/grant.js";
import type { Request, Response } from "express";
import { accessOf } from "../schemas.js";
import {
  getGrant as get,
  removeGrant,
  replaceGrant as replace,
} from "../../../../grants/service.js";

/** Who acts: past the route's check without `zeteo.grants.write`, the table's owner. */
const actorOf = (req: Request) => {
  const caller = callerOf(req);
  return hasPermission(caller.permissions, GRANTS_WRITE)
    ? { actorId: caller.userId }
    : { actorId: caller.userId, owner: caller };
};

const respond = async (res: Response, row: Awaited<ReturnType<typeof get>>) => {
  const [statuses, names] = await Promise.all([
    principalStatuses([row]),
    ruleNamesFor([row.rowRule as RuleFilter | null]),
  ]);
  res
    .status(200)
    .json(
      grantView(row, statuses.get(row.principalType, row.principalId), names)
    );
};

export const getGrant = async (req: Request, res: Response) => {
  const { grantId } = validateParams(GrantParamsSchema, req);
  await respond(res, await get(grantId));
};

export const replaceGrant = async (req: Request, res: Response) => {
  const { grantId } = validateParams(GrantParamsSchema, req);
  const body = validateBody(ReplaceGrantSchema, req);
  const row = await replace(grantId, accessOf(body), actorOf(req));
  await respond(res, row);
};

export const deleteGrant = async (req: Request, res: Response) => {
  const { grantId } = validateParams(GrantParamsSchema, req);
  await removeGrant(grantId, actorOf(req));
  res.status(204).end();
};
