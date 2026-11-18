import { validateBody, validateParams } from "../../../../utils/validateReq.js";
import { SOURCES_WRITE } from "../../../../definitions/tereoDeclaration.js";
import { NotFoundError, NotSyncedError } from "../../../../utils/errors.js";
import { SourceParamsSchema, UpdateSourceSchema } from "./schemas.js";
import { refreshAfterChange } from "../../../../catalog/refresh.js";
import { hasPermission } from "../../../../utils/permissions.js";
import { isUploadSource } from "../../../../sources/types.js";
import { lacking } from "../../../../uploads/ownership.js";
import { callerOf } from "../../../../middleware/auth.js";
import { db } from "../../../../utils/db/index.js";
import type { Request, Response } from "express";
import {
  UPLOAD_SOURCE_FIELDS,
  updateSource as update,
} from "../../../../sources/service.js";
import {
  deleteUploadSource,
  changeUploadSource,
} from "../../../../uploads/service.js";
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
 * or change its description (as may an admin, recorded as a change of the
 * upload source); its limits are an admin's.
 */
export const updateSource = async (req: Request, res: Response) => {
  const { sourceId } = validateParams(SourceParamsSchema, req);
  const body = validateBody(UpdateSourceSchema, req);
  const caller = callerOf(req);
  const row = await db.sources.findById(sourceId);
  if (!row) throw new NotFoundError("Source not found");
  const { sync_interval_minutes: syncInterval, ...rest } = body;
  if (
    isUploadSource(row) &&
    Object.keys(rest).every((key) =>
      UPLOAD_SOURCE_FIELDS.has(key as keyof typeof rest)
    )
  ) {
    const { name, description } = rest;
    res.status(200).json(
      await changeUploadSource(caller, sourceId, {
        ...(name !== undefined && { name }),
        ...(description !== undefined && { description }),
        ...(syncInterval !== undefined && {
          sync_interval_minutes: syncInterval,
        }),
      })
    );
    return;
  }
  if (!hasPermission(caller.permissions, SOURCES_WRITE)) {
    throw lacking(SOURCES_WRITE);
  }
  if (syncInterval !== undefined) throw new NotSyncedError();
  const updated = await update(sourceId, rest, caller.userId);
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
  await deleteUploadSource(callerOf(req), sourceId);
  res.status(204).end();
};
