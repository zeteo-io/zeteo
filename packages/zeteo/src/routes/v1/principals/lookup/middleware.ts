import { countSearch } from "../../../../principals/searchRateLimit.js";
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
 * Who may look principals up. Admins reading grants or runs look up any id.
 * A file source owner (`zeteo.file_sources.write` with `zeteo.data.read`)
 * and nothing more is let in only to name who their tables are shared with:
 * `res.locals.ownerLookup` tells the handler to answer only the principals
 * holding a grant on a file source they own, and the call counts against the
 * search rate limit, as it reaches tereo on their behalf.
 */
export const requireLookup: RequestHandler = (req, res, next) => {
  const caller = callerOf(req);
  if (
    hasPermission(caller.permissions, GRANTS_READ) ||
    hasPermission(caller.permissions, RUNS_READ)
  ) {
    return next();
  }
  if (!mayActAsOwner(caller)) return next(new ForbiddenError(MESSAGE));
  res.locals.ownerLookup = true;
  countSearch(caller.userId).then(() => next(), next);
};
