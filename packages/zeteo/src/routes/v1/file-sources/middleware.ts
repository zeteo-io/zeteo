import { FileSourcesNotConfiguredError } from "../../../utils/errors.js";
import type { RequestHandler } from "express";
import env from "../../../env.js";
import {
  DATA_READ,
  FILE_SOURCES_WRITE,
  SOURCES_READ,
} from "../../../definitions/tereoDeclaration.js";
import {
  requireAnyPermission,
  requirePermission,
} from "../../../middleware/auth.js";

const needsRead = requirePermission(DATA_READ);

/**
 * Every file-source route: 404 `file_sources_not_configured` while
 * `FILE_SOURCES_READER_URL` is unset (whoever asks), then `zeteo.data.read`.
 */
export const requireFileSources: RequestHandler = (req, res, next) => {
  if (!env.FILE_SOURCES_READER_URL) {
    return next(new FileSourcesNotConfiguredError());
  }
  needsRead(req, res, next);
};

/** Uploading and creating: `zeteo.file_sources.write`. */
export const requireFileSourcesWrite = requirePermission(FILE_SOURCES_WRITE);

/**
 * Listing and managing: an owner's `zeteo.file_sources.write` or an admin's
 * `zeteo.sources.read`; the service decides per source.
 */
export const requireFileSourcesManage = requireAnyPermission([
  FILE_SOURCES_WRITE,
  SOURCES_READ,
]);
