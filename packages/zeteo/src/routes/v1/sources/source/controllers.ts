import { validateBody, validateParams } from "../../../../utils/validateReq.js";
import { SOURCES_WRITE } from "../../../../definitions/tereoDeclaration.js";
import { updateSource as update } from "../../../../sources/service.js";
import { SourceParamsSchema, UpdateSourceSchema } from "./schemas.js";
import { refreshAfterChange } from "../../../../catalog/refresh.js";
import { hasPermission } from "../../../../utils/permissions.js";
import { lacking } from "../../../../file-sources/ownership.js";
import { NotFoundError } from "../../../../utils/errors.js";
import { isFileSource } from "../../../../sources/types.js";
import { callerOf } from "../../../../middleware/auth.js";
import { db } from "../../../../utils/db/index.js";
import type { Request, Response } from "express";
import {
  deleteFileSource,
  renameFileSource,
} from "../../../../file-sources/service.js";
import {
  presentSource,
  presentSourceById,
} from "../../../../sources/present.js";

export const getSource = async (req: Request, res: Response) => {
  const { sourceId } = validateParams(SourceParamsSchema, req);
  res.status(200).json(await presentSourceById(sourceId));
};

/**
 * An admin changes any source. An upload source's owner may only rename it
 * (as may an admin, recorded as a change of the upload source); its limits
 * are an admin's.
 */
export const updateSource = async (req: Request, res: Response) => {
  const { sourceId } = validateParams(SourceParamsSchema, req);
  const body = validateBody(UpdateSourceSchema, req);
  const caller = callerOf(req);
  const row = await db.sources.findById(sourceId);
  if (!row) throw new NotFoundError("Source not found");
  if (
    isFileSource(row) &&
    body.name !== undefined &&
    Object.keys(body).length === 1
  ) {
    res.status(200).json(await renameFileSource(caller, sourceId, body.name));
    return;
  }
  if (!hasPermission(caller.permissions, SOURCES_WRITE)) {
    throw lacking(SOURCES_WRITE);
  }
  const updated = await update(sourceId, body, caller.userId);
  // New settings or schemas describe another target: the catalogue follows now,
  // not at the next daily refresh. The change stands whether or not this works.
  if (body.settings === undefined && body.schemas === undefined) {
    res.status(200).json(await presentSource(updated));
    return;
  }
  await refreshAfterChange(updated.id, caller.userId);
  const fresh = (await db.sources.findById(updated.id)) ?? updated;
  res.status(200).json(await presentSource(fresh));
};

/** An upload source only: deletes its data and marks it deleted (archived). */
export const deleteSource = async (req: Request, res: Response) => {
  const { sourceId } = validateParams(SourceParamsSchema, req);
  await deleteFileSource(callerOf(req), sourceId);
  res.status(204).end();
};
