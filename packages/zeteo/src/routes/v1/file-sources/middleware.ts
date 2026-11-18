import { FileSourcesNotConfiguredError } from "../../../utils/errors.js";
import { requirePermission } from "../../../middleware/auth.js";
import type { RequestHandler } from "express";
import env from "../../../env.js";
import {
  DATA_READ,
  FILE_SOURCES_WRITE,
} from "../../../definitions/tereoDeclaration.js";

const needsRead = requirePermission(DATA_READ);
const needsWrite = requirePermission(FILE_SOURCES_WRITE);

/**
 * Every file-source route: 404 `file_sources_not_configured` while
 * `FILE_SOURCES_READER_URL` is unset (whoever asks), then `zeteo.data.read`
 * and `zeteo.file_sources.write`.
 */
export const requireFileSources: RequestHandler = (req, res, next) => {
  if (!env.FILE_SOURCES_READER_URL) {
    return next(new FileSourcesNotConfiguredError());
  }
  needsRead(req, res, (err?: unknown) => {
    if (err) return next(err);
    needsWrite(req, res, next);
  });
};
