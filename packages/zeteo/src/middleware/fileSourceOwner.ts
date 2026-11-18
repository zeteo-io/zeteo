import { hasPermission } from "../utils/permissions.js";
import type { Request, RequestHandler } from "express";
import { IdSchema } from "../utils/idSchema.js";
import { callerOf } from "./auth.js";
import {
  lacking,
  mayActAsOwner,
  ownsFileSourceOf,
} from "../file-sources/ownership.js";

/** The source a request acts on, or undefined when it names none (or names it badly). */
export type SourceLocator = (req: Request) => Promise<string | undefined>;

/** `value` as an id, or undefined when it is not one. */
export const idOrUndefined = (value: unknown): string | undefined => {
  const parsed = IdSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
};

/**
 * As `requirePermission(permission)`, but also lets through the owner of the
 * file source `locate` finds, holding `zeteo.file_sources.write` and
 * `zeteo.data.read`. Anyone else gets the very 403 `requirePermission` gives,
 * whether the source exists or not. Without `locate`, it only refuses early a
 * caller who could be neither (before a body is read); a later
 * `allowOwnerOr` with `locate` decides.
 */
export const allowOwnerOr =
  (permission: string, locate?: SourceLocator): RequestHandler =>
  (req, _res, next) => {
    const caller = callerOf(req);
    if (hasPermission(caller.permissions, permission)) return next();
    if (!mayActAsOwner(caller)) return next(lacking(permission));
    if (!locate) return next();
    locate(req)
      .then((sourceId) =>
        sourceId === undefined ? false : ownsFileSourceOf(caller, sourceId)
      )
      .then((owns) => next(owns ? undefined : lacking(permission)), next);
  };
