import type { PrincipalLimit } from "../../../../../prisma/generated/client/index.js";
import { validateBody, validateParams } from "../../../../utils/validateReq.js";
import { principalStatuses } from "../../../../grants/principalStatuses.js";
import { principalLimitView } from "../../../../views/principalLimit.js";
import { callerOf } from "../../../../middleware/auth.js";
import type { Request, Response } from "express";
import {
  getPrincipalLimit as get,
  removePrincipalLimit,
  updatePrincipalLimit as update,
} from "../../../../limits/service.js";
import {
  PrincipalLimitParamsSchema,
  UpdatePrincipalLimitSchema,
} from "./schemas.js";

const respond = async (res: Response, row: PrincipalLimit) => {
  const statuses = await principalStatuses([row]);
  res
    .status(200)
    .json(
      principalLimitView(row, statuses.get(row.principalType, row.principalId))
    );
};

export const getPrincipalLimit = async (req: Request, res: Response) => {
  const { principalLimitId } = validateParams(PrincipalLimitParamsSchema, req);
  await respond(res, await get(principalLimitId));
};

export const updatePrincipalLimit = async (req: Request, res: Response) => {
  const { principalLimitId } = validateParams(PrincipalLimitParamsSchema, req);
  const body = validateBody(UpdatePrincipalLimitSchema, req);
  const row = await update(
    principalLimitId,
    {
      queryConcurrency: body.query_concurrency,
      exportConcurrency: body.export_concurrency,
    },
    callerOf(req).userId
  );
  await respond(res, row);
};

export const deletePrincipalLimit = async (req: Request, res: Response) => {
  const { principalLimitId } = validateParams(PrincipalLimitParamsSchema, req);
  await removePrincipalLimit(principalLimitId, callerOf(req).userId);
  res.status(204).end();
};
