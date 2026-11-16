import { getTereo } from "../../../utils/tereo.js";
import { logger } from "../../../utils/logger.js";
import type { RequestHandler } from "express";

const BEARER = /^Bearer (.+)$/i;

/**
 * Drops the token's cached introspection, which `requireAuth` would otherwise
 * reuse for up to a minute, so the admin UI reloading after a live permission
 * change reads the permissions as they are now. Must run before `authenticate`.
 */
export const dropCachedIntrospection: RequestHandler = async (
  req,
  _res,
  next
) => {
  const token = BEARER.exec(req.headers.authorization ?? "")?.[1];
  if (token) {
    try {
      await getTereo().auth.invalidateToken(token);
    } catch (err) {
      logger.warn({ err }, "Could not drop the cached token introspection");
    }
  }
  next();
};
