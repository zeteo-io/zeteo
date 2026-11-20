import { assertNoTransaction, getTereo } from "../utils/tereo.js";
import { withinRedisTimeout } from "../utils/redisTimeout.js";
import { TEST_ORPHANED_KEY } from "../grants/principals.js";
import { TereoUnreachableError } from "../utils/errors.js";
import { mapConcurrently } from "../utils/concurrency.js";
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

/**
 * An entry of test mode's directory: a `Principal`, and for a group its
 * organization (null or absent: global), for a user their type.
 */
export type TestDirectoryEntry = Principal & {
  organization_id?: string | null;
  user_type?: AuthServiceUser["userType"];
};

/** Test mode's directory: a Redis hash of `${type}:${id}` to a JSON `TestDirectoryEntry`. */
export const TEST_DIRECTORY_KEY = "zeteo:test:directory";

/** Tereo's most ids in one `getUsersByIds` request. */
export const MAX_USER_IDS_PER_REQUEST = 100;

/**
 * How long one search or lookup may wait on tereo, retries included. The SDK
 * sets no timeout and the handler retries timeouts and 5xx with back-off, so
 * without this a silent tereo could hold a request for minutes.
 */
export const DIRECTORY_BUDGET_MS = 5000;

/** How many groups one lookup reads from tereo at once; each is its own request, and a 429 would pause every call zeteo makes to tereo. */
export const GROUP_READS_IN_FLIGHT = 8;

export const GROUP_CACHE_TTL_SECONDS = 60;
export const groupCacheKey = (id: string) => `zeteo:directory:group:${id}`;

/**
 * How long reading the whole directory may wait on tereo: up to
 * `MAX_DIRECTORY / 200` pages of users and `MAX_DIRECTORY / 100` of groups,
 * one after the other.
 */
export const DIRECTORY_LIST_BUDGET_MS = 20_000;

/** The most users, and the most groups, `listAllPrincipals` reads. */
export const MAX_DIRECTORY = 5000;

/** Tereo's largest page of users, and of groups. */
const USERS_PAGE = 200;
const GROUPS_PAGE = 100;

class DirectoryDeadlineError extends Error {
  constructor(readonly budgetMs: number) {
    super(`tereo did not answer within ${budgetMs} ms`);
    this.name = "DirectoryDeadlineError";
  }
}

/**
 * `run`, or a `DirectoryDeadlineError` once it has taken the budget. The
 * signal aborts when the call ends either way, cancelling the requests that
 * were given it and any still running beside a failed one.
 */
const withinBudget = async <T>(
  run: (signal: AbortSignal) => Promise<T>,
  budgetMs = DIRECTORY_BUDGET_MS
): Promise<T> => {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new DirectoryDeadlineError(budgetMs)),
      budgetMs
    );
  });
  const work = run(controller.signal);
  // Settling after the deadline, it must not be an unhandled rejection.
  work.catch(() => undefined);
  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const chunks = <T>(items: T[], size: number): T[][] =>
  Array.from({ length: Math.ceil(items.length / size) }, (_, i) =>
    items.slice(i * size, (i + 1) * size)
  );

const refKey = (ref: PrincipalRef) => `${ref.type}:${ref.id}`;

/** How an id the directory does not know is answered. */
export const orphaned = (ref: PrincipalRef): Principal =>
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
  const outcome =
    err instanceof DirectoryDeadlineError
      ? `did not finish within ${err.budgetMs} ms`
      : `failed${status === undefined ? "" : ` with HTTP ${status}`}`;
  logger.error(
    {
      err: new Error(`${call} ${outcome}`),
      ...counts,
    },
    "asking tereo for users or groups failed"
  );
  return new TereoUnreachableError();
};

interface PaginatedUsers {
  data: AuthServiceUser[];
  hasMore?: boolean;
  nextCursor?: string | null;
}

/** One page of `GET /v1/admin/users` through the raw handler, as the SDK's requests do on a 401: a new service token, once. */
const getUsersPage = async (
  params: Record<string, string | number>,
  signal: AbortSignal,
  requestName = "zeteo.directory.searchUsers"
): Promise<PaginatedUsers> => {
  const send = () =>
    getHandler().handleRequest<PaginatedUsers>({
      clientName: CORE_CLIENT,
      requestName,
      method: "GET",
      url: "/v1/admin/users",
      params,
      signal,
    });
  try {
    return (await send()).data;
  } catch (err) {
    if (statusOf(err) !== 401) throw err;
    logger.warn("tereo rejected the service token; retrying once");
    await purgeServiceToken();
    return (await send()).data;
  }
};

const getUsers = async (
  params: Record<string, string | number>,
  signal: AbortSignal
): Promise<AuthServiceUser[]> => (await getUsersPage(params, signal)).data;

/** Users whose name or email contains `q`: two requests, as tereo's filters are ANDed. Human users only. */
const searchUsers = async (
  q: string,
  limit: number,
  signal: AbortSignal
): Promise<Principal[]> => {
  const base = { "filter[userType]": "human", limit };
  const [byName, byEmail] = await Promise.all([
    getUsers(
      { ...base, "filter[name]": q, "filter[name_op]": "contains" },
      signal
    ),
    getUsers(
      { ...base, "filter[email]": q, "filter[email_op]": "contains" },
      signal
    ),
  ]);
  const seen = new Map<string, AuthServiceUser>();
  for (const u of [...byName, ...byEmail])
    if (!seen.has(u.id)) seen.set(u.id, u);
  return [...seen.values()].slice(0, limit).map(fromUser);
};

/** Narrows a group search to the global groups and those of `organizationId` (null: global only). */
export interface SearchScope {
  organizationId: string | null;
}

const searchGroups = async (
  q: string,
  limit: number,
  scope?: SearchScope
): Promise<Principal[]> => {
  if (scope === undefined) {
    const page = await requests.auth.listGroups({ q, limit });
    return page.data.slice(0, limit).map(fromGroup);
  }
  const organizations = ["global", scope.organizationId].filter(
    (o): o is string => o !== null
  );
  const pages = await Promise.all(
    organizations.map((organizationId) =>
      requests.auth.listGroups({ q, limit, organizationId })
    )
  );
  const seen = new Map<string, Principal>();
  for (const g of pages.flatMap((page) => page.data))
    if (!seen.has(g.id)) seen.set(g.id, fromGroup(g));
  return [...seen.values()].slice(0, limit);
};

/** `searchPrincipals` against tereo itself. */
export const searchFromTereo = async (
  type: PrincipalType,
  q: string,
  limit: number,
  scope?: SearchScope
): Promise<Principal[]> => {
  assertNoTransaction(`tereo search ${type}s`);
  try {
    return await withinBudget((signal) =>
      type === "user"
        ? searchUsers(q, limit, signal)
        : searchGroups(q, limit, scope)
    );
  } catch (err) {
    throw unreachable(`searching ${type}s`, err, { limit });
  }
};

/** The whole directory as `listAllPrincipals` gives it. */
export interface DirectoryListing {
  principals: Principal[];
  /** True when there were more users, or more groups, than `MAX_DIRECTORY`. */
  truncated: boolean;
}

interface CursorPage<T> {
  data: T[];
  hasMore?: boolean;
  nextCursor?: string | null;
}

/** Reads a cursor-paged list from tereo until its end or `cap` items; `truncated` when more remained. */
const readPages = async <T>(
  next: (cursor: string | undefined) => Promise<CursorPage<T>>,
  cap: number,
  signal: AbortSignal
): Promise<{ items: T[]; truncated: boolean }> => {
  const items: T[] = [];
  let cursor: string | undefined;
  for (;;) {
    if (signal.aborted) throw new Error("directory read abandoned");
    const page = await next(cursor);
    items.push(...page.data);
    if (items.length > cap)
      return { items: items.slice(0, cap), truncated: true };
    const more = page.hasMore === true && typeof page.nextCursor === "string";
    if (!more) return { items, truncated: false };
    if (items.length === cap) return { items, truncated: true };
    cursor = page.nextCursor!;
  }
};

/** By name, case-insensitively, a principal without a name last; ties by type, then id. */
const byName = (a: Principal, b: Principal): number => {
  if (a.name === null || b.name === null) {
    if (a.name !== b.name) return a.name === null ? 1 : -1;
  } else {
    const order = a.name.localeCompare(b.name, undefined, {
      sensitivity: "base",
    });
    if (order !== 0) return order;
  }
  return a.type.localeCompare(b.type) || a.id.localeCompare(b.id);
};

/** Every user (human users only, with a `scope`), at most `cap`. */
const listAllUsers = (cap: number, signal: AbortSignal, scope?: SearchScope) =>
  readPages<AuthServiceUser>(
    (cursor) =>
      getUsersPage(
        {
          limit: Math.min(USERS_PAGE, cap),
          ...(scope === undefined ? {} : { "filter[userType]": "human" }),
          ...(cursor === undefined ? {} : { cursor }),
        },
        signal,
        "zeteo.directory.listUsers"
      ),
    cap,
    signal
  );

/** Every live group (with a `scope`, the global ones and its organization's), at most `cap`. */
const listAllGroups = async (
  cap: number,
  signal: AbortSignal,
  scope?: SearchScope
): Promise<{ items: Principal[]; truncated: boolean }> => {
  const limit = Math.min(GROUPS_PAGE, cap);
  const read = (organizationId?: string) =>
    readPages(
      (cursor) =>
        requests.auth.listGroups({
          limit,
          ...(organizationId === undefined ? {} : { organizationId }),
          ...(cursor === undefined ? {} : { cursor }),
        }),
      cap,
      signal
    );
  const organizations =
    scope === undefined
      ? [undefined]
      : ["global", scope.organizationId].filter((o): o is string => o !== null);
  const lists = await Promise.all(organizations.map(read));
  const seen = new Map<string, Principal>();
  for (const g of lists.flatMap((list) => list.items))
    if (!seen.has(g.id)) seen.set(g.id, fromGroup(g));
  const items = [...seen.values()];
  return {
    items: items.slice(0, cap),
    truncated: items.length > cap || lists.some((list) => list.truncated),
  };
};

/** `listAllPrincipals` against tereo itself; `cap` is per type. */
export const listAllFromTereo = async (
  scope?: SearchScope,
  cap = MAX_DIRECTORY
): Promise<DirectoryListing> => {
  assertNoTransaction("tereo listAllPrincipals()");
  try {
    return await withinBudget(async (signal) => {
      const [users, groups] = await Promise.all([
        listAllUsers(cap, signal, scope),
        listAllGroups(cap, signal, scope),
      ]);
      return {
        principals: [...users.items.map(fromUser), ...groups.items].sort(
          byName
        ),
        truncated: users.truncated || groups.truncated,
      };
    }, DIRECTORY_LIST_BUDGET_MS);
  } catch (err) {
    throw unreachable("listing users and groups", err, { cap });
  }
};

/*
 * Groups' resolved principals are cached, found or orphaned, never a failed
 * read. Users are not: their names and emails are personal data, kept out of
 * Redis. A cache that fails or is slow is passed over.
 */
const readGroupCache = async (
  ids: string[]
): Promise<Map<string, Principal>> => {
  const cached = new Map<string, Principal>();
  if (ids.length === 0) return cached;
  try {
    const values = await withinRedisTimeout(
      redis.mget(...ids.map(groupCacheKey))
    );
    ids.forEach((id, i) => {
      const value = values[i];
      if (value) cached.set(id, JSON.parse(value) as Principal);
    });
  } catch (err) {
    logger.warn({ err }, "directory group cache unreadable; asking tereo");
    cached.clear();
  }
  return cached;
};

const writeGroupCache = async (groups: Principal[]): Promise<void> => {
  const results = await Promise.allSettled(
    groups.map((g) =>
      withinRedisTimeout(
        redis.set(
          groupCacheKey(g.id),
          JSON.stringify(g),
          "EX",
          GROUP_CACHE_TTL_SECONDS
        )
      )
    )
  );
  const failed = results.filter((r) => r.status === "rejected");
  if (failed.length > 0) {
    logger.warn(
      { err: failed[0]!.reason, failed: failed.length },
      "directory group cache not written"
    );
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
  const readGroups: Principal[] = [];
  assertNoTransaction("tereo lookupPrincipals()");
  try {
    await withinBudget(async (signal) => {
      const cached = await readGroupCache(groupIds);
      for (const [id, p] of cached) found.set(`group:${id}`, p);
      const unread = groupIds.filter((id) => !cached.has(id));
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
        mapConcurrently(
          unread,
          GROUP_READS_IN_FLIGHT,
          async (id) => {
            const group = await getTereo().auth.getGroup(id);
            readGroups.push(
              group ? fromGroup(group) : orphaned({ type: "group", id })
            );
          },
          signal
        ),
      ]);
    });
  } catch (err) {
    throw unreachable("looking up principals", err, { refs: distinct.length });
  }
  for (const p of readGroups) found.set(`group:${p.id}`, p);
  // Not awaited: the answer does not wait on the cache, and the write never rejects.
  void writeGroupCache(readGroups);
  return distinct.map((r) => found.get(refKey(r)) ?? orphaned(r));
};

/** `groupOrganizationOf` against tereo itself. */
export const groupOrganizationFromTereo = async (
  id: string
): Promise<string | null | undefined> => {
  if (!UUID.test(id)) return undefined;
  assertNoTransaction("tereo getGroup()");
  try {
    return await withinBudget(async () => {
      const group = await getTereo().auth.getGroup(id);
      return group === null ? undefined : group.organizationId;
    });
  } catch (err) {
    throw unreachable("reading a group", err, { refs: 1 });
  }
};

/** `isServiceAccountUser` against tereo itself; uncached, as users' data is kept out of Redis. */
export const isServiceAccountFromTereo = async (
  id: string
): Promise<boolean> => {
  if (!UUID.test(id)) return false;
  assertNoTransaction("tereo getUser()");
  try {
    return await withinBudget(async () => {
      try {
        const user = await requests.auth.getUser(id);
        return user.userType === "service_account";
      } catch (err) {
        if (statusOf(err) === 404) return false;
        throw err;
      }
    });
  } catch (err) {
    throw unreachable("reading a user", err, { refs: 1 });
  }
};

/** A test-mode seam's Redis read; one that fails or does not answer in time is `tereo_unreachable`. */
const readSeam = async <T>(command: Promise<T>, refs: number): Promise<T> => {
  try {
    return await withinRedisTimeout(command);
  } catch (err) {
    throw unreachable("reading the test directory", err, { refs });
  }
};

/** A seam entry as the directory gives it: without the seam's own fields. */
const asPrincipal = (json: string): Principal => {
  const {
    organization_id: _organization,
    user_type: _userType,
    ...principal
  } = JSON.parse(json) as TestDirectoryEntry;
  return principal;
};

const seeded = async (): Promise<TestDirectoryEntry[]> =>
  Object.values(await readSeam(redis.hgetall(TEST_DIRECTORY_KEY), 0)).map(
    (json) => JSON.parse(json) as TestDirectoryEntry
  );

/** The seam's entry for `ref`, or undefined when it has none or the id is marked orphaned. */
const seamEntry = async (
  ref: PrincipalRef
): Promise<TestDirectoryEntry | undefined> => {
  const [value, mark] = await readSeam(
    Promise.all([
      redis.hget(TEST_DIRECTORY_KEY, refKey(ref)),
      redis.sismember(TEST_ORPHANED_KEY, ref.id),
    ]),
    1
  );
  return value === null || mark === 1
    ? undefined
    : (JSON.parse(value) as TestDirectoryEntry);
};

const searchSeam = async (
  type: PrincipalType,
  q: string,
  limit: number,
  scope?: SearchScope
): Promise<Principal[]> => {
  const needle = q.toLowerCase();
  return (await seeded())
    .filter(
      (p) =>
        p.type === type &&
        p.status !== "orphaned" &&
        [p.name, p.email].some((v) => v?.toLowerCase().includes(needle)) &&
        (type === "user" ||
          scope === undefined ||
          (p.organization_id ?? null) === null ||
          p.organization_id === scope.organizationId) &&
        (type === "group" || p.user_type !== "service_account")
    )
    .sort((a, b) => a.id.localeCompare(b.id))
    .slice(0, limit)
    .map((p) => asPrincipal(JSON.stringify(p)));
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
    marks[i] === 1 || values[i] === null ? orphaned(r) : asPrincipal(values[i])
  );
};

const listSeam = async (
  scope: SearchScope | undefined,
  cap: number
): Promise<DirectoryListing> => {
  const [entries, orphans] = await Promise.all([
    seeded(),
    readSeam(redis.smembers(TEST_ORPHANED_KEY), 0),
  ]);
  const gone = new Set(orphans);
  const listed = entries.filter(
    (p) =>
      p.status !== "orphaned" &&
      !gone.has(p.id) &&
      (scope === undefined ||
        (p.type === "user"
          ? p.user_type !== "service_account"
          : (p.organization_id ?? null) === null ||
            p.organization_id === scope.organizationId))
  );
  const ofType = (type: PrincipalType) =>
    listed
      .filter((p) => p.type === type)
      .sort((a, b) => a.id.localeCompare(b.id));
  const users = ofType("user");
  const groups = ofType("group");
  return {
    principals: [...users.slice(0, cap), ...groups.slice(0, cap)]
      .map((p) => asPrincipal(JSON.stringify(p)))
      .sort(byName),
    truncated: users.length > cap || groups.length > cap,
  };
};

/**
 * Users or groups whose name (or a user's email) contains `q`, at most
 * `limit`. A user search leaves out service accounts; a group search with a
 * `scope` finds only global groups and those of the scope's organization. An
 * unreachable tereo is a `TereoUnreachableError`.
 */
export const searchPrincipals = (
  type: PrincipalType,
  q: string,
  limit: number,
  scope?: SearchScope
): Promise<Principal[]> =>
  env.TEREO_TEST_MODE
    ? searchSeam(type, q, limit, scope)
    : searchFromTereo(type, q, limit, scope);

/**
 * Every user and every group, by name (a principal without one last), at
 * most `cap` (`MAX_DIRECTORY`) of each, read page by page from tereo;
 * `truncated` when there were more. Admin scope (no `scope`): every user,
 * service accounts included, and every live group. With a `scope`: human
 * users only, and the global groups and those of the scope's organization.
 * Users are never cached. An unreachable tereo is a `TereoUnreachableError`.
 */
export const listAllPrincipals = (
  scope?: SearchScope,
  cap = MAX_DIRECTORY
): Promise<DirectoryListing> =>
  env.TEREO_TEST_MODE ? listSeam(scope, cap) : listAllFromTereo(scope, cap);

/**
 * One principal per ref, in the refs' order, a repeated ref collapsed to its
 * first. A user or group tereo does not have is `orphaned`, with no name. Any
 * other failure is a `TereoUnreachableError`, never `orphaned`. At most 100 refs.
 */
export const lookupPrincipals = (refs: PrincipalRef[]): Promise<Principal[]> =>
  env.TEREO_TEST_MODE ? lookupSeam(refs) : lookupFromTereo(refs);

/**
 * The organization a group belongs to: its id, null for a global group, and
 * undefined when there is no such group. An unreachable tereo is a
 * `TereoUnreachableError`. Not to be called inside a transaction.
 */
export const groupOrganizationOf = async (
  id: string
): Promise<string | null | undefined> => {
  if (!env.TEREO_TEST_MODE) return groupOrganizationFromTereo(id);
  const entry = await seamEntry({ type: "group", id });
  return entry === undefined ? undefined : (entry.organization_id ?? null);
};

/**
 * Whether the user is a service account; false when there is no such user.
 * An unreachable tereo is a `TereoUnreachableError`. Not to be called
 * inside a transaction.
 */
export const isServiceAccountUser = async (id: string): Promise<boolean> => {
  if (!env.TEREO_TEST_MODE) return isServiceAccountFromTereo(id);
  const entry = await seamEntry({ type: "user", id });
  return entry?.user_type === "service_account";
};

/** Test mode's members of a group: a Redis JSON array of user ids. */
export const testGroupMembersKey = (groupId: string) =>
  `zeteo:test:group-members:${groupId}`;

/** Tereo's largest page of a group's members. */
const MEMBERS_PAGE = 100;

/** `groupMemberIds` against tereo itself. */
export const groupMemberIdsFromTereo = async (
  id: string
): Promise<string[]> => {
  if (!UUID.test(id)) return [];
  assertNoTransaction("tereo listGroupMembers()");
  try {
    return await withinBudget(async (signal) => {
      try {
        const { items, truncated } = await readPages(
          (cursor) =>
            requests.auth.listGroupMembers(id, {
              limit: MEMBERS_PAGE,
              ...(cursor !== undefined && { cursor }),
            }),
          MAX_DIRECTORY,
          signal
        );
        if (truncated) {
          logger.warn(
            { group_id: id, cap: MAX_DIRECTORY },
            "a group has more members than are read; the rest are left out"
          );
        }
        return items.map((m) => m.userId);
      } catch (err) {
        if (statusOf(err) === 404) return [];
        throw err;
      }
    }, DIRECTORY_LIST_BUDGET_MS);
  } catch (err) {
    throw unreachable("listing a group's members", err, { refs: 1 });
  }
};

/**
 * The ids of a group's members, at most `MAX_DIRECTORY`; none when there is
 * no such group. An unreachable tereo is a `TereoUnreachableError`. Not to
 * be called inside a transaction.
 */
export const groupMemberIds = async (id: string): Promise<string[]> => {
  if (!env.TEREO_TEST_MODE) return groupMemberIdsFromTereo(id);
  const raw = await readSeam(redis.get(testGroupMembersKey(id)), 1);
  return raw === null ? [] : (JSON.parse(raw) as string[]);
};
