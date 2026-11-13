import { getGroup, listUserGroups } from "../utils/tereoGroups.js";
import { requests, RequestError } from "@tereo-io/sdk/handler";
import { ServiceUnavailableError } from "../utils/errors.js";
import { assertNoTransaction } from "../utils/tereo.js";
import type { Caller } from "../middleware/auth.js";
import { logger } from "../utils/logger.js";
import { redis } from "../utils/redis.js";
import env from "../env.js";

export interface GroupRef {
  id: string;
  organizationId: string | null;
}

export type PrincipalStatus = "active" | "orphaned" | "unknown";

export const GROUPS_TTL_SECONDS = 30;
export const groupsKey = (userId: string) => `zeteo:groups:${userId}`;
export const testGroupsKey = (userId: string) => `zeteo:test:groups:${userId}`;
export const TEST_ORPHANED_KEY = "zeteo:test:orphaned";

const unavailable = () =>
  new ServiceUnavailableError("Group membership is temporarily unavailable");

/** The HTTP status of a failed request to tereo (an axios error or the SDK's), if it got an answer. */
const httpStatusOf = (err: unknown): number | undefined => {
  if (err instanceof RequestError) return err.httpStatus;
  const status = (err as { response?: { status?: unknown } } | null)?.response
    ?.status;
  return typeof status === "number" ? status : undefined;
};

/** A user's groups from tereo; a 404 (no such user, or a core without groups) is no groups. */
export const fetchGroupsFromTereo = async (
  userId: string
): Promise<GroupRef[]> => {
  assertNoTransaction("tereo listUserGroups()");
  try {
    const { data } = await listUserGroups(userId);
    return data.map(({ id, organizationId }) => ({ id, organizationId }));
  } catch (err) {
    if (httpStatusOf(err) === 404) return [];
    throw err;
  }
};

/**
 * The user's groups through `fetch`, cached 30 s in Redis (unfiltered). A
 * failed fetch is a 503, never an empty list.
 */
export const resolveGroupsWith = async (
  fetch: (userId: string) => Promise<GroupRef[]>,
  userId: string
): Promise<GroupRef[]> => {
  const key = groupsKey(userId);
  try {
    const cached = await redis.get(key);
    if (cached !== null) return JSON.parse(cached) as GroupRef[];
  } catch (err) {
    logger.warn({ err }, "group cache unreadable; asking tereo");
  }
  let groups: GroupRef[];
  try {
    groups = await fetch(userId);
  } catch (err) {
    logger.error({ err, user_id: userId }, "listing a user's groups failed");
    throw unavailable();
  }
  try {
    await redis.set(key, JSON.stringify(groups), "EX", GROUPS_TTL_SECONDS);
  } catch (err) {
    logger.warn({ err }, "group cache not written");
  }
  return groups;
};

const testGroups = async (userId: string): Promise<GroupRef[]> => {
  const raw = await redis.get(testGroupsKey(userId));
  return raw === null ? [] : (JSON.parse(raw) as GroupRef[]);
};

/** Ids of the groups whose grants count for the caller: global ones and those of the token's organization. */
export const groupIdsOf = async (caller: Caller): Promise<string[]> => {
  if (caller.isServiceAccount) return [];
  const groups = env.TEREO_TEST_MODE
    ? await testGroups(caller.userId)
    : await resolveGroupsWith(fetchGroupsFromTereo, caller.userId);
  return groups
    .filter(
      (g) =>
        g.organizationId === null || g.organizationId === caller.organizationId
    )
    .map((g) => g.id);
};

/**
 * Whether a grant's principal still exists in tereo. A user is `orphaned`
 * when tereo has no such user. A group's existence cannot be read, so it is
 * `active` or, when tereo refuses or has none, `unknown`.
 */
/** `principalStatus` against tereo itself. */
export const statusFromTereo = async (
  type: "user" | "group",
  id: string
): Promise<PrincipalStatus> => {
  assertNoTransaction(`tereo ${type === "user" ? "getUser" : "getGroup"}()`);
  try {
    if (type === "user") await requests.auth.getUser(id);
    else await getGroup(id);
    return "active";
  } catch (err) {
    const status = httpStatusOf(err);
    if (type === "user" && status === 404) return "orphaned";
    if (type === "group" && (status === 403 || status === 404)) {
      return "unknown";
    }
    logger.error({ err, principal_id: id }, "reading a principal failed");
    throw unavailable();
  }
};

export const principalStatus = async (
  type: "user" | "group",
  id: string
): Promise<PrincipalStatus> => {
  if (env.TEREO_TEST_MODE) {
    return (await redis.sismember(TEST_ORPHANED_KEY, id)) === 1
      ? "orphaned"
      : "active";
  }
  return statusFromTereo(type, id);
};
