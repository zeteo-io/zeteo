import { lookupPrincipals } from "../../../principals/directory.js";
import { callerOf } from "../../../middleware/auth.js";
import { logger } from "../../../utils/logger.js";
import type { Request, Response } from "express";

const ZETEO_PREFIX = "zeteo.";

/** How long the first call of the UI waits for tereo's directory before answering without a name. */
export const NAME_LOOKUP_DEADLINE_MS = 2000;

/** Held permissions that decide what zeteo lets the caller do: `zeteo.*`, plus bare `admin`, which `hasPermission` lets cover every permission. */
const zeteoPermissions = (held: string[]): string[] =>
  held.filter((p) => p.startsWith(ZETEO_PREFIX) || p === "admin").sort();

/** The caller's name and email; null for both when the directory fails, is slow or does not know the user, since the permissions matter more. */
const nameAndEmail = async (userId: string) => {
  const none = { name: null, email: null };
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<"late">((resolve) => {
    timer = setTimeout(() => resolve("late"), NAME_LOOKUP_DEADLINE_MS);
  });
  // An abandoned lookup may still reject; the catch keeps that from being unhandled.
  const lookup = lookupPrincipals([{ type: "user", id: userId }]).catch(
    (err: unknown) => ({ err })
  );
  try {
    const result = await Promise.race([lookup, deadline]);
    if (result === "late") {
      logger.warn("The directory did not name the signed-in user in time");
      return none;
    }
    if ("err" in result) {
      logger.warn(
        { err: result.err },
        "Could not look up the signed-in user's name"
      );
      return none;
    }
    const [principal] = result;
    if (!principal || principal.status === "orphaned") return none;
    return { name: principal.name, email: principal.email ?? null };
  } finally {
    clearTimeout(timer);
  }
};

export const getMeHandler = async (req: Request, res: Response) => {
  const caller = callerOf(req);
  res.setHeader("Cache-Control", "no-store");
  res.status(200).json({
    id: caller.userId,
    type: caller.isServiceAccount ? "service" : "user",
    ...(await nameAndEmail(caller.userId)),
    permissions: zeteoPermissions(caller.permissions),
  });
};
