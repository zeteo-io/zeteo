import { lookupPrincipals } from "../../../principals/directory.js";
import { callerOf } from "../../../middleware/auth.js";
import { logger } from "../../../utils/logger.js";
import type { Request, Response } from "express";

const ZETEO_PREFIX = "zeteo.";

/** Held permissions that decide what zeteo lets the caller do: `zeteo.*`, plus bare `admin`, which `hasPermission` lets cover every permission. */
const zeteoPermissions = (held: string[]): string[] =>
  held.filter((p) => p.startsWith(ZETEO_PREFIX) || p === "admin").sort();

/** The caller's name and email; null for both when the directory fails or does not know the user, since the permissions matter more. */
const nameAndEmail = async (userId: string) => {
  try {
    const [principal] = await lookupPrincipals([{ type: "user", id: userId }]);
    if (!principal || principal.status === "orphaned") {
      return { name: null, email: null };
    }
    return { name: principal.name, email: principal.email ?? null };
  } catch (err) {
    logger.warn({ err }, "Could not look up the signed-in user's name");
    return { name: null, email: null };
  }
};

export const getMeHandler = async (req: Request, res: Response) => {
  const caller = callerOf(req);
  res.status(200).json({
    id: caller.userId,
    type: caller.isServiceAccount ? "service" : "user",
    ...(await nameAndEmail(caller.userId)),
    permissions: zeteoPermissions(caller.permissions),
  });
};
