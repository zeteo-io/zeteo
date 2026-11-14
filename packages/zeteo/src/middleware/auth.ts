import { hasPermission } from "../utils/permissions.js";
import type { RequestHandler, Request } from "express";
import { ForbiddenError } from "../utils/errors.js";
import type { AuthContext } from "@tereo-io/sdk";
import { getTereo } from "../utils/tereo.js";

export interface Caller {
  userId: string;
  /** From the token's `org_id`; null for a token without one. */
  organizationId: string | null;
  permissions: string[];
  isServiceAccount: boolean;
}

declare global {
  namespace Express {
    interface Request {
      caller?: Caller;
    }
  }
}

/** The caller a verified token stands for, over HTTP or MCP. */
export const callerFromAuth = (auth: AuthContext): Caller => ({
  userId: auth.userId,
  organizationId: auth.organizationId,
  permissions: auth.permissions,
  isServiceAccount: auth.userType === "service_account",
});

/**
 * Verifies the bearer token with tereo (401 `unauthorized` without a valid
 * one), then sets `req.caller`.
 */
export const authenticate: RequestHandler = (req, res, next) => {
  void getTereo().auth.requireAuth(req, res, (err?: unknown) => {
    if (err) return next(err);
    if (!req.auth) return next(new Error("requireAuth set no req.auth"));
    req.caller = callerFromAuth(req.auth);
    next();
  });
};

export const callerOf = (req: Request): Caller => {
  if (!req.caller) throw new Error("callerOf used before authenticate");
  return req.caller;
};

/** Refuses (403) a caller without `permission`, or a permission above it on its ladder; needs `authenticate` before it. */
export const requirePermission =
  (permission: string): RequestHandler =>
  (req, _res, next) => {
    if (!hasPermission(callerOf(req).permissions, permission)) {
      return next(new ForbiddenError(`Requires the ${permission} permission`));
    }
    next();
  };

/** Refuses (403) a caller holding none of `permissions` (each on its ladder, as in `requirePermission`); needs `authenticate` before it. */
export const requireAnyPermission = (permissions: string[]): RequestHandler => {
  const message = `Requires one of: ${permissions.join(", ")}`;
  return (req, _res, next) => {
    const held = callerOf(req).permissions;
    if (!permissions.some((p) => hasPermission(held, p))) {
      return next(new ForbiddenError(message));
    }
    next();
  };
};
