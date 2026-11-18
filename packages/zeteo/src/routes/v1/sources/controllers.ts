import { validateBody, validateQuery } from "../../../utils/validateReq.js";
import { presentSource, presentSources } from "../../../sources/present.js";
import { mayActAsOwner, lacking } from "../../../uploads/ownership.js";
import { encodeCursor, parseCursor } from "../../../utils/cursor.js";
import { createSource as create } from "../../../sources/service.js";
import { refreshAfterChange } from "../../../catalog/refresh.js";
import { hasPermission } from "../../../utils/permissions.js";
import { storedType } from "../../../sources/types.js";
import { callerOf } from "../../../middleware/auth.js";
import type { Request, Response } from "express";
import { db } from "../../../utils/db/index.js";
import {
  DATA_READ,
  UPLOADS_WRITE,
  SOURCES_READ,
  SOURCES_WRITE,
} from "../../../definitions/tereoDeclaration.js";
import {
  assertUploadsOn,
  createUploadSource,
} from "../../../uploads/service.js";
import {
  CreateSourceSchema,
  CreateUploadSourceSchema,
  ListSourcesQuerySchema,
  SourceCursorSchema,
} from "./schemas.js";

/**
 * Every source for `zeteo.sources.read`; with `owner_id=me`, also an owner
 * holding `zeteo.uploads.write` (and `zeteo.data.read`), who sees only
 * their own.
 */
export const listSources = async (req: Request, res: Response) => {
  const query = validateQuery(ListSourcesQuerySchema, req);
  const caller = callerOf(req);
  if (
    !hasPermission(caller.permissions, SOURCES_READ) &&
    !(query.owner_id === "me" && mayActAsOwner(caller))
  ) {
    throw lacking(SOURCES_READ);
  }
  let after: { createdAt: Date; id: string } | undefined;
  if (query.cursor !== undefined) {
    const [createdAt, id] = parseCursor(query.cursor, SourceCursorSchema);
    after = { createdAt: new Date(createdAt), id };
  }
  const page = await db.sources.listPage({
    includeArchived: query.include_archived,
    limit: query.limit,
    after,
    type: query.type === undefined ? undefined : storedType(query.type),
    ownerId: query.owner_id === "me" ? caller.userId : query.owner_id,
  });
  const last = page.rows.at(-1);
  res.status(200).json({
    data: await presentSources(page.rows),
    next_cursor:
      page.hasMore && last
        ? encodeCursor([last.createdAt.toISOString(), last.id])
        : null,
  });
};

const isUpload = (body: unknown): boolean =>
  typeof body === "object" &&
  body !== null &&
  (body as { type?: unknown }).type === "upload";

/**
 * A database source for `zeteo.sources.write`; an upload source (`type:
 * "upload"`, from the caller's staging) for `zeteo.uploads.write` with
 * `zeteo.data.read`.
 */
export const createSource = async (req: Request, res: Response) => {
  const caller = callerOf(req);
  if (isUpload(req.body)) {
    assertUploadsOn();
    for (const permission of [DATA_READ, UPLOADS_WRITE]) {
      if (!hasPermission(caller.permissions, permission)) {
        throw lacking(permission);
      }
    }
    const { type: _, ...input } = validateBody(CreateUploadSourceSchema, req);
    res.status(201).json(await createUploadSource(caller, input));
    return;
  }
  if (!hasPermission(caller.permissions, SOURCES_WRITE)) {
    throw lacking(SOURCES_WRITE);
  }
  const body = validateBody(CreateSourceSchema, req);
  const created = await create(body, caller.userId);
  await refreshAfterChange(created.id, caller.userId);
  const row = (await db.sources.findById(created.id)) ?? created;
  res.status(201).json(await presentSource(row));
};
