import { UploadsNotConfiguredError } from "../../../utils/errors.js";
import { requirePermission } from "../../../middleware/auth.js";
import type { RequestHandler } from "express";
import env from "../../../env.js";
import {
  DATA_READ,
  UPLOADS_WRITE,
} from "../../../definitions/tereoDeclaration.js";

const needsRead = requirePermission(DATA_READ);
const needsWrite = requirePermission(UPLOADS_WRITE);

/**
 * Every upload route: 404 `uploads_not_configured` while
 * `UPLOADS_READER_URL` is unset (whoever asks), then `zeteo.data.read`
 * and `zeteo.uploads.write`.
 */
export const requireUploads: RequestHandler = (req, res, next) => {
  if (!env.UPLOADS_READER_URL) {
    return next(new UploadsNotConfiguredError());
  }
  needsRead(req, res, (err?: unknown) =>
    err ? next(err) : needsWrite(req, res, next)
  );
};
