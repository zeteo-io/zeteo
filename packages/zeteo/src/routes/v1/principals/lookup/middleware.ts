import { mayActAsOwner } from "../../../../file-sources/ownership.js";
import { hasPermission } from "../../../../utils/permissions.js";
import { ForbiddenError } from "../../../../utils/errors.js";
import { callerOf } from "../../../../middleware/auth.js";
import type { RequestHandler } from "express";
import {
  FILE_SOURCES_WRITE,
  GRANTS_READ,
  RUNS_READ,
} from "../../../../definitions/tereoDeclaration.js";

const MESSAGE = `Requires one of: ${GRANTS_READ}, ${RUNS_READ}, ${FILE_SOURCES_WRITE}`;

/**
 * Names for ids: admins reading grants or runs, and file source owners
 * (`zeteo.file_sources.write` with `zeteo.data.read`), who see who their
 * tables are shared with. They can already find the same people and groups
 * by name through `GET /v1/me/principals`.
 */
export const requireLookup: RequestHandler = (req, _res, next) => {
  const caller = callerOf(req);
  const allowed =
    hasPermission(caller.permissions, GRANTS_READ) ||
    hasPermission(caller.permissions, RUNS_READ) ||
    mayActAsOwner(caller);
  next(allowed ? undefined : new ForbiddenError(MESSAGE));
};
