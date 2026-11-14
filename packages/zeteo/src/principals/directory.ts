import { assertNoTransaction, getTereo } from "../utils/tereo.js";
import { withinRedisTimeout } from "../utils/redisTimeout.js";
import { TEST_ORPHANED_KEY } from "../grants/principals.js";
import { TereoUnreachableError } from "../utils/errors.js";
import type { AuthServiceUser } from "@tereo-io/sdk";
import { logger } from "../utils/logger.js";
import { redis } from "../utils/redis.js";
import env from "../env.js";
import {
  purgeServiceToken,
  getHandler,
  requests,
  RequestError,
  CORE_CLIENT,
} from "@tereo-io/sdk/handler";

export type PrincipalType = "user" | "group";

export interface Principal {
  type: PrincipalType;
  id: string;
  name: string | null;
  /** Users only; a group has no `email` key. */
  email?: string | null;
  status: "active" | "inactive" | "orphaned";
}

export interface PrincipalRef {
  type: PrincipalType;
  id: string;
}

/** Test mode's directory: a Redis hash of `${type}:${id}` to a JSON `Principal`. */
export const TEST_DIRECTORY_KEY = "zeteo:test:directory";

/** Tereo's most ids in one `getUsersByIds` request. */
export const MAX_USER_IDS_PER_REQUEST = 100;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const chunks = <T>(items: T[], size: number): T[][] =>
  Array.from({ length: Math.ceil(items.length / size) }, (_, i) =>
    items.slice(i * size, (i + 1) * size)
  );

const refKey = (ref: PrincipalRef) => `${ref.type}:${ref.id}`;

const orphaned = (ref: PrincipalRef): Principal =>
  ref.type === "user"
    ? { type: "user", id: ref.id, name: null, email: null, status: "orphaned" }
    : { type: "group", id: ref.id, name: null, status: "orphaned" };

const fromUser = (u: AuthServiceUser): Principal => ({
  type: "user",
  id: u.id,
  name: u.name,
  email: u.email,
  status: u.status === "active" ? "active" : "inactive",
});

const fromGroup = (g: {
  id: string;
  name: string;
  archivedAt: string | null;
}): Principal => ({
  type: "group",
  id: g.id,
  name: g.name,
  status: g.archivedAt === null ? "active" : "inactive",
});

/** The HTTP status of a failed request to tereo, when it answered: the SDK's `RequestError`, or the raw handler's axios error. */
const statusOf = (err: unknown): number | undefined => {
  if (err instanceof RequestError) return err.httpStatus;
  const e = err as { isAxiosError?: unknown; response?: { status?: unknown } };
  // Not `instanceof AxiosError`: @dianemo/core's axios may be another copy.
  return e?.isAxiosError === true && typeof e.response?.status === "number"
    ? e.response.status
    : undefined;
};

/**
 * Logs a failed call and returns the error to throw. The logged error is a new
 * one: the raw handler's axios error carries the request's params, the search
 * text among them, and nothing of that may reach the log.
 */
const unreachable = (
  call: string,
  err: unknown,
  counts: Record<string, number>
): TereoUnreachableError => {
  const status = statusOf(err);
  logger.error(
    {
      err: new Error(
        `${call} failed${status === undefined ? "" : ` with HTTP ${status}`}`
      ),
      ...counts,
    },
    "asking tereo for users or groups failed"
  );
  return new TereoUnreachableError();
};

interface PaginatedUsers {
  data: AuthServiceUser[];
}

/** One `GET /v1/admin/users` through the raw handler, as the SDK's requests do on a 401: a new service token, once. */
const getUsers = async (
  params: Record<string, string | number>
): Promise<AuthServiceUser[]> => {
  const send = () =>
    getHandler().handleRequest<PaginatedUsers>({
      clientName: CORE_CLIENT,
      requestName: "zeteo.directory.searchUsers",
      method: "GET",
      url: "/v1/admin/users",
      params,
    });
  try {
    return (await send()).data.data;
  } catch (err) {
    if (statusOf(err) !== 401) throw err;
    logger.warn("tereo rejected the service token; retrying once");
    await purgeServiceToken();
    return (await send()).data.data;
  }
};

/** Users whose name or email contains `q`: two requests, as tereo's filters are ANDed. Human users only. */
const searchUsers = async (q: string, limit: number): Promise<Principal[]> => {
  const base = { "filter[userType]": "human", limit };
  const [byName, byEmail] = await Promise.all([
    getUsers({ ...base, "filter[name]": q, "filter[name_op]": "contains" }),
    getUsers({ ...base, "filter[email]": q, "filter[email_op]": "contains" }),
  ]);
  const seen = new Map<string, AuthServiceUser>();
  for (const u of [...byName, ...byEmail])
    if (!seen.has(u.id)) seen.set(u.id, u);
  return [...seen.values()].slice(0, limit).map(fromUser);
};

const searchGroups = async (q: string, limit: number): Promise<Principal[]> => {
  const page = await requests.auth.listGroups({ q, limit });
  return page.data.slice(0, limit).map(fromGroup);
};

/** `searchPrincipals` against tereo itself. */
export const searchFromTereo = async (
  type: PrincipalType,
  q: string,
  limit: number
): Promise<Principal[]> => {
  assertNoTransaction(`tereo search ${type}s`);
  try {
    return type === "user"
      ? await searchUsers(q, limit)
      : await searchGroups(q, limit);
  } catch (err) {
    throw unreachable(`searching ${type}s`, err, { limit });
  }
};

/** `lookupPrincipals` against tereo itself. */
export const lookupFromTereo = async (
  refs: PrincipalRef[]
): Promise<Principal[]> => {
  const distinct = [...new Map(refs.map((r) => [refKey(r), r])).values()];
  // An id that is no UUID cannot be anyone's: tereo would answer 400, not 404.
  const askable = distinct.filter((r) => UUID.test(r.id));
  const userIds = askable.filter((r) => r.type === "user").map((r) => r.id);
  const groupIds = askable.filter((r) => r.type === "group").map((r) => r.id);
  const found = new Map<string, Principal>();
  assertNoTransaction("tereo lookupPrincipals()");
  try {
    await Promise.all([
      ...chunks(userIds, MAX_USER_IDS_PER_REQUEST).map(async (ids) => {
        for (const u of await requests.auth.getUsersByIds(ids)) {
          // A malformed element would be filed under the wrong id and read as an orphan.
          if (typeof u?.id !== "string" || typeof u.status !== "string") {
            throw new Error("tereo returned a malformed user");
          }
          found.set(`user:${u.id}`, fromUser(u));
        }
      }),
      ...groupIds.map(async (id) => {
        const group = await getTereo().auth.getGroup(id);
        if (group) found.set(`group:${id}`, fromGroup(group));
      }),
    ]);
  } catch (err) {
    throw unreachable("looking up principals", err, { refs: distinct.length });
  }
  return distinct.map((r) => found.get(refKey(r)) ?? orphaned(r));
};

/** A test-mode seam's Redis read; one that fails or does not answer in time is `tereo_unreachable`. */
const readSeam = async <T>(command: Promise<T>, refs: number): Promise<T> => {
  try {
    return await withinRedisTimeout(command);
  } catch (err) {
    throw unreachable("reading the test directory", err, { refs });
  }
};

const seeded = async (): Promise<Principal[]> =>
  Object.values(await readSeam(redis.hgetall(TEST_DIRECTORY_KEY), 0)).map(
    (json) => JSON.parse(json) as Principal
  );

const searchSeam = async (
  type: PrincipalType,
  q: string,
  limit: number
): Promise<Principal[]> => {
  const needle = q.toLowerCase();
  return (await seeded())
    .filter(
      (p) =>
        p.type === type &&
        p.status !== "orphaned" &&
        [p.name, p.email].some((v) => v?.toLowerCase().includes(needle))
    )
    .sort((a, b) => a.id.localeCompare(b.id))
    .slice(0, limit);
};

const lookupSeam = async (refs: PrincipalRef[]): Promise<Principal[]> => {
  const distinct = [...new Map(refs.map((r) => [refKey(r), r])).values()];
  if (distinct.length === 0) return [];
  const [values, marks] = await Promise.all([
    readSeam(
      redis.hmget(TEST_DIRECTORY_KEY, ...distinct.map(refKey)),
      refs.length
    ),
    readSeam(
      Promise.all(
        distinct.map((r) => redis.sismember(TEST_ORPHANED_KEY, r.id))
      ),
      refs.length
    ),
  ]);
  return distinct.map((r, i) =>
    marks[i] === 1 || values[i] === null
      ? orphaned(r)
      : (JSON.parse(values[i]) as Principal)
  );
};

/**
 * Users or groups whose name (or a user's email) contains `q`, at most
 * `limit`. A user search leaves out service accounts, an unreachable tereo
 * is a `TereoUnreachableError`.
 */
export const searchPrincipals = (
  type: PrincipalType,
  q: string,
  limit: number
): Promise<Principal[]> =>
  env.TEREO_TEST_MODE
    ? searchSeam(type, q, limit)
    : searchFromTereo(type, q, limit);

/**
 * One principal per ref, in the refs' order, a repeated ref collapsed to its
 * first. A user or group tereo does not have is `orphaned`, with no name. Any
 * other failure is a `TereoUnreachableError`, never `orphaned`. At most 100 refs.
 */
export const lookupPrincipals = (refs: PrincipalRef[]): Promise<Principal[]> =>
  env.TEREO_TEST_MODE ? lookupSeam(refs) : lookupFromTereo(refs);
