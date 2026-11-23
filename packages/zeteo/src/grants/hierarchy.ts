import { assertNoTransaction, getTereo } from "../utils/tereo.js";
import { RequestError } from "@tereo-io/sdk/handler";
import { logger } from "../utils/logger.js";

export const HIERARCHY_TTL_SECONDS = 30;

/** Tereo could not say who is below a user: unreachable, erroring, or no such user. Fail closed. */
export class HierarchyUnavailableError extends Error {
  constructor(message = "The reporting lines are temporarily unavailable") {
    super(message);
    this.name = "HierarchyUnavailableError";
  }
}

/** Tereo refused the read as too large (over 10,000 users or 64 levels): it never returns a truncated list. */
export class HierarchyTooLargeError extends Error {
  constructor(message = "Too many users report to this user") {
    super(message);
    this.name = "HierarchyTooLargeError";
  }
}

const cache = new Map<string, { ids: string[]; expires: number }>();

/** Forgets every cached answer (tests). */
export const clearHierarchyCache = (): void => cache.clear();

/**
 * The ids of every user below `userId` in tereo's reporting lines, at any
 * depth, deactivated users included, as tereo returns them. Cached 30 s per
 * user in this process; a failure is never cached. In test mode the SDK
 * answers with no reports.
 */
export const usersBelow = async (userId: string): Promise<string[]> => {
  assertNoTransaction("tereo listUserReports()");
  const hit = cache.get(userId);
  if (hit && hit.expires > Date.now()) return hit.ids;
  let reports;
  try {
    reports = await getTereo().auth.listUserReports(userId, {
      transitive: true,
    });
  } catch (err) {
    if (err instanceof RequestError && err.httpStatus === 422) {
      throw new HierarchyTooLargeError();
    }
    logger.error({ err, user_id: userId }, "listing a user's reports failed");
    throw new HierarchyUnavailableError();
  }
  if (reports === null) {
    logger.error({ user_id: userId }, "tereo has no reporting lines for user");
    throw new HierarchyUnavailableError();
  }
  const ids = reports.map((r) => r.id);
  cache.set(userId, {
    ids,
    expires: Date.now() + HIERARCHY_TTL_SECONDS * 1000,
  });
  return ids;
};
