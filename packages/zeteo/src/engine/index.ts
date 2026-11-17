import { QueryFailedError, ValidationError } from "../utils/errors.js";
import { fingerprintOf, refusalFingerprintOf } from "./fingerprint.js";
import { loadAccess, type CallerAccess } from "../grants/access.js";
import { claim, failureWindowOf, release } from "./recordWindow.js";
import type { VisibleCatalog } from "../grants/visibleCatalog.js";
import { planSaved, type SavedQueryToPlan } from "./savedPlan.js";
import { loadVisibleCatalog } from "../grants/visibleCatalog.js";
import { stampSavedQueryRun } from "../saved-queries/stamps.js";
import { coalesce, waitForLeases } from "./dashboardRun.js";
import { withSourceConnection } from "../sources/pools.js";
import { invalidRequest } from "../utils/validateReq.js";
import { loadUserLimits } from "../limits/resolve.js";
import type { CachedResult } from "./resultCache.js";
import type { Caller } from "../middleware/auth.js";
import { planFor, type Progress } from "./plan.js";
import type { QueryEntryPoint } from "./limits.js";
import * as resultCache from "./resultCache.js";
import { performance } from "node:perf_hooks";
import { logger } from "../utils/logger.js";
import { db } from "../utils/db/index.js";
import { notFound } from "./errors.js";
import { collect } from "./collect.js";
import env from "../env.js";
import { z } from "zod";
import type {
  ColumnType,
  PlanContext,
  QueryPlan,
  QueryResult,
  QueryWarning,
  SourceAdapter,
} from "../adapters/types.js";
import {
  acquireRunLeases,
  LEASE_GRACE_MS,
  LIMIT_PROFILES,
  runLimits,
  type UserLimits,
} from "./limits.js";
import {
  CLIENT_CLOSED,
  failureOf,
  recordRun,
  type RunRecord,
  UNRECORDABLE_QUERY,
  WITHHELD_QUERY,
} from "./record.js";

export interface RunQueryInput {
  caller: Caller;
  entryPoint: QueryEntryPoint;
  /** The query as the caller sent it. */
  body: unknown;
  /** Aborts when the caller goes away: the run is stopped on the source. */
  signal?: AbortSignal;
  /** The caller's concurrency limits; read for the caller as the run starts when absent. */
  userLimits?: UserLimits;
  /**
   * The saved query `body` is the JSON of (its paging overridden), when it is
   * one: it is planned as `planSaved` plans, so any refusal is
   * `saved_query_not_accessible`, and the run is recorded against it.
   */
  savedQuery?: SavedRun;
  /**
   * Set only by src/dashboards/ (a convention test holds it to that), never
   * from a request: the run is a dashboard panel's, with entry point
   * `dashboard` and a saved query. It plans against `now`, reads and fills
   * the result cache, shares an execution with identical runs in this
   * process, waits for its leases, and is recorded at most once per window.
   */
  dashboard?: DashboardRun;
}

/** A dashboard's run of one panel's query. */
export interface DashboardRun {
  dashboardId: string;
  /** The minute relative dates and the dashboard's time range resolve against. */
  now: Date;
}

/** A saved query being run: its id, and the source it is planned against. */
export interface SavedRun {
  id: string;
  sourceId: string;
}

export interface RunQueryResult {
  columns: { name: string; type: ColumnType }[];
  rows: unknown[][];
  truncated: boolean;
  /** Why rows were left out, when some were. */
  truncated_by?: "rows" | "bytes";
  warnings: QueryWarning[];
  run_id: string;
}

/**
 * A dashboard run's result: `run_id` only when this run was recorded, and
 * `cached_at` when its rows came from the cache.
 */
export type DashboardRunResult = Omit<RunQueryResult, "run_id"> & {
  run_id?: string;
  cached_at?: string;
};

/** What every query must be before anything else: an object naming a source. */
const ShapeSchema = z.looseObject({
  source: z.string().min(1, { error: "source is the slug of a source" }),
});

// A UTF-16 surrogate without its partner: ill-formed Unicode.
const LONE_SURROGATE =
  /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

/** A string no stored run can hold: NUL, or ill-formed Unicode (Postgres `jsonb` refuses both). */
const unstorable = (s: string): boolean =>
  s.includes("\u0000") || LONE_SURROGATE.test(s);

/** Whether any string or key in a JSON value is unstorable, walked without recursion. */
const holdsUnstorable = (value: unknown): boolean => {
  const pending: unknown[] = [value];
  while (pending.length > 0) {
    const next = pending.pop();
    if (typeof next === "string") {
      if (unstorable(next)) return true;
    } else if (Array.isArray(next)) {
      pending.push(...next);
    } else if (next !== null && typeof next === "object") {
      for (const [key, inner] of Object.entries(next)) {
        if (unstorable(key)) return true;
        pending.push(inner);
      }
    }
  }
  return false;
};

const UNSTORABLE_MESSAGE =
  "No string or key in a query may hold NUL or ill-formed Unicode";

/**
 * Step 1: the body is an object with a source slug. No language allows NUL or
 * ill-formed Unicode, and a stored run cannot hold either, so both are
 * refused here, before anything is recorded.
 */
export const sourceSlugOf = (body: unknown): string => {
  const shape = ShapeSchema.safeParse(body);
  if (!shape.success) throw invalidRequest("body", shape.error);
  if (holdsUnstorable(body)) {
    throw new ValidationError(`Invalid request body. ${UNSTORABLE_MESSAGE}`, [
      { path: "", message: UNSTORABLE_MESSAGE },
    ]);
  }
  return shape.data.source;
};

const columnsMatch = (
  plan: QueryPlan,
  columns: { name: string; type: ColumnType }[]
): boolean =>
  columns.length === plan.columns.length &&
  columns.every(
    (c, i) =>
      c.name === plan.columns[i]!.name && c.type === plan.columns[i]!.type
  );

const rowsMatch = (plan: QueryPlan, rows: unknown[][]): boolean =>
  rows.every((row) => Array.isArray(row) && row.length === plan.columns.length);

const resultMismatch = (
  plan: QueryPlan,
  columns: { name: string; type: ColumnType }[],
  sourceId: string
): QueryFailedError => {
  logger.error(
    {
      source_id: sourceId,
      expected: plan.columns.map(({ name, type }) => ({ name, type })),
      received: columns.map(({ name, type }) => ({ name, type })),
    },
    "a query result does not match its plan"
  );
  return new QueryFailedError();
};

/** The result's columns must be the plan's, in order. */
export const checkColumns = (
  plan: QueryPlan,
  columns: { name: string; type: ColumnType }[],
  sourceId: string
): void => {
  if (!columnsMatch(plan, columns)) {
    throw resultMismatch(plan, columns, sourceId);
  }
};

/** Every row must be as wide as the plan's columns. */
export const checkRows = (
  plan: QueryPlan,
  columns: { name: string; type: ColumnType }[],
  rows: unknown[][],
  sourceId: string
): void => {
  if (!rowsMatch(plan, rows)) throw resultMismatch(plan, columns, sourceId);
};

/** Step 6: the result must be the plan's columns, in order, and every row that wide. */
const checkResult = (
  plan: QueryPlan,
  result: QueryResult,
  sourceId: string
): void => {
  checkColumns(plan, result.columns, sourceId);
  checkRows(plan, result.columns, result.rows, sourceId);
};

/**
 * Step 2: what the caller is granted, and the source as they may see it. A
 * source they cannot see is not found, whether or not it exists.
 */
export const loadCatalogFor = async (
  caller: Caller,
  slug: string,
  progress: Progress
): Promise<{ access: CallerAccess; catalog: VisibleCatalog }> => {
  const access = await loadAccess(caller);
  const catalog = await loadVisibleCatalog(slug, access);
  if (!catalog) {
    throw notFound(
      "source",
      slug,
      ["source"],
      await db.sources.listSlugs(access.sourceIds)
    );
  }
  progress.sourceId = catalog.source.id;
  return { access, catalog };
};

/**
 * Steps 2 and 3 for the run of a saved query: what the caller is granted, and
 * the stored JSON planned against the saved query's own source as they may
 * see it. Any refusal is `SavedQueryNotAccessibleError`.
 */
export const loadAndPlanSaved = async (
  caller: Caller,
  saved: SavedRun,
  body: unknown,
  progress: Progress,
  ctx?: PlanContext
): Promise<Planned> => {
  const access = await loadAccess(caller);
  const toPlan: SavedQueryToPlan = {
    sourceId: saved.sourceId,
    query: body as SavedQueryToPlan["query"],
  };
  return { access, ...(await planSaved(access, toPlan, progress, ctx)) };
};

/** A query planned for its caller. */
interface Planned {
  access: CallerAccess;
  catalog: VisibleCatalog;
  adapter: SourceAdapter;
  plan: QueryPlan;
}

/**
 * What a run is recorded with: the body, and the saved query it came from.
 * A saved query whose run never got past the access decision keeps its JSON
 * out of the record, so the caller's own runs cannot show what was withheld.
 */
export const recordedQueryOf = (
  body: unknown,
  savedQuery: SavedRun | undefined,
  progress: Progress
): Pick<RunRecord, "query" | "savedQueryId"> =>
  savedQuery
    ? {
        query: progress.sourceId === null ? WITHHELD_QUERY : body,
        savedQueryId: savedQuery.id,
      }
    : { query: body };

/**
 * Records the run; when the row cannot be stored, records it again with a
 * placeholder for the query, so the run and its audit entry exist either
 * way. Throws only when both attempts fail.
 */
export const recordRunOrPlaceholder = async (
  run: RunRecord
): Promise<string> => {
  try {
    return await recordRun(run);
  } catch (err) {
    logger.error(
      { err, source_id: run.sourceId },
      "recording a query run failed; recording it without its query"
    );
    return recordRun({ ...run, query: UNRECORDABLE_QUERY });
  }
};

/** Steps 2 to 6. */
const execute = async (
  input: RunQueryInput,
  slug: string,
  progress: Progress
): Promise<{ plan: QueryPlan; result: QueryResult }> => {
  const { caller, body, savedQuery } = input;
  const planned = savedQuery
    ? await loadAndPlanSaved(caller, savedQuery, body, progress)
    : await loadCatalogFor(caller, slug, progress).then((loaded) => ({
        ...loaded,
        ...planFor(body, loaded.access, loaded.catalog, progress),
      }));
  return { plan: planned.plan, result: await runPlanned(input, planned) };
};

/**
 * Steps 4 to 6 for a planned query: compiled, leases taken (waited for on a
 * dashboard's run, refused at once otherwise), run on the source within the
 * entry point's limits and one deadline, and checked against the plan.
 */
const runPlanned = async (
  { caller, entryPoint, signal, userLimits, dashboard }: RunQueryInput,
  { access, catalog, adapter, plan }: Planned
): Promise<QueryResult> => {
  const sourceId = catalog.source.id;
  const ownLimits = userLimits ?? (await loadUserLimits(access));

  const limits = runLimits(entryPoint, plan.limit, catalog.source);
  // Compiled before any lease is taken, so a query the source cannot take is
  // refused as such, never as busy.
  const prepared = adapter.prepare(plan, {
    limit: limits.maxRows + 1,
    offset: plan.offset,
  });
  // One deadline for the whole run, pool wait included.
  const deadlineAt = performance.now() + limits.timeoutMs;
  signal?.throwIfAborted();
  // The source's limit as this run's catalogue read it.
  const acquire = () =>
    acquireRunLeases(
      caller.userId,
      catalog.source,
      limits.timeoutMs + LEASE_GRACE_MS,
      ownLimits
    );
  const release = dashboard
    ? await waitForLeases(acquire, deadlineAt, signal)
    : await acquire();
  let result: QueryResult;
  try {
    result = await withSourceConnection(sourceId, async (conn) => {
      const stream = await conn.openQuery(
        prepared,
        { ...limits, deadlineAt },
        signal
      );
      try {
        return { columns: stream.columns, ...(await collect(stream, limits)) };
      } finally {
        await stream.close();
      }
    });
  } finally {
    // Not waited for: a release that fails is logged, and its lease lapses.
    void release();
  }
  checkResult(plan, result, sourceId);
  return result;
};

/**
 * Runs one query from any entry point: checks its shape, resolves its source
 * and plans it against what the caller may see, runs it within the entry
 * point's limits, and records it. Every query past the shape check is
 * recorded, refused and failed ones included; rows are returned only once
 * their run is recorded.
 */
export function runQuery(
  input: RunQueryInput & { dashboard: DashboardRun }
): Promise<DashboardRunResult>;
export function runQuery(
  input: RunQueryInput & { dashboard?: undefined }
): Promise<RunQueryResult>;
export async function runQuery(
  input: RunQueryInput
): Promise<RunQueryResult | DashboardRunResult> {
  const isDashboard = input.entryPoint === "dashboard";
  if (
    isDashboard !== (input.dashboard !== undefined) ||
    (isDashboard && !input.savedQuery)
  ) {
    throw new Error(
      "a dashboard run needs the dashboard entry point, the dashboard option and a saved query, all three"
    );
  }
  if (input.dashboard && input.savedQuery) {
    return runDashboardQuery(input, input.dashboard, input.savedQuery);
  }
  const slug = sourceSlugOf(input.body);
  const started = performance.now();
  const progress: Progress = { sourceId: null, unrecorded: false };
  const record = (
    outcome: Pick<RunRecord, "outcome" | "errorCode" | "rowCount" | "truncated">
  ): Promise<string> =>
    recordRunOrPlaceholder({
      caller: input.caller,
      sourceId: progress.sourceId,
      entryPoint: input.entryPoint,
      ...recordedQueryOf(input.body, input.savedQuery, progress),
      durationMs: Math.round(performance.now() - started),
      ...outcome,
    });

  let ran: Awaited<ReturnType<typeof execute>>;
  try {
    ran = await execute(input, slug, progress);
  } catch (err) {
    if (progress.unrecorded) throw err;
    const closed =
      input.signal?.aborted === true && err === input.signal.reason;
    const failure = closed
      ? { outcome: "failed" as const, errorCode: CLIENT_CLOSED }
      : failureOf(err);
    try {
      await record({ ...failure, rowCount: null, truncated: false });
    } catch (recordErr) {
      logger.error(
        { err: recordErr, source_id: progress.sourceId },
        "a failed query run could not be recorded, even without its query"
      );
    }
    throw err;
  }

  const { plan, result } = ran;
  let runId: string;
  try {
    runId = await record({
      outcome: "ok",
      errorCode: null,
      rowCount: result.rows.length,
      truncated: result.truncated !== false,
    });
  } catch (err) {
    logger.error(
      { err, source_id: progress.sourceId },
      "a query run could not be recorded, even without its query; its rows are withheld"
    );
    throw err;
  }
  if (input.savedQuery) {
    // Not waited for: a stamp that fails is logged, and the run stands.
    void stampSavedQueryRun(input.savedQuery.id, input.caller.userId);
  }
  return {
    columns: result.columns,
    rows: result.rows,
    truncated: result.truncated !== false,
    ...(result.truncated !== false && { truncated_by: result.truncated }),
    warnings: plan.warnings,
    run_id: runId,
  };
}

/** The rows of a run as they are shown and kept in the cache. */
const shownOf = (result: QueryResult, at: Date): CachedResult => ({
  columns: result.columns,
  rows: result.rows,
  truncated: result.truncated !== false,
  ...(result.truncated !== false && { truncated_by: result.truncated }),
  cached_at: at.toISOString(),
});

/**
 * A dashboard panel's run of a saved query: planned as the viewer against
 * the dashboard's `now`, then served from the cache, or executed (once for
 * every identical run in this process) and kept there. It is recorded, and
 * the saved query stamped, only when it opens the viewer's recording window
 * for this query; a refusal likewise, with its query withheld. Rows are
 * returned only once a recorded run is recorded.
 */
const runDashboardQuery = async (
  input: RunQueryInput,
  dashboard: DashboardRun,
  savedQuery: SavedRun
): Promise<DashboardRunResult> => {
  sourceSlugOf(input.body);
  const { caller, signal } = input;
  const started = performance.now();
  const progress: Progress = { sourceId: null, unrecorded: false };
  const windowMinutes = env.DASHBOARD_RECORD_WINDOW_MINUTES;
  let cached = false;
  const record = (
    outcome: Pick<RunRecord, "outcome" | "errorCode" | "rowCount" | "truncated">
  ): Promise<string> =>
    recordRunOrPlaceholder({
      caller,
      sourceId: progress.sourceId,
      entryPoint: "dashboard",
      ...recordedQueryOf(input.body, savedQuery, progress),
      dashboardId: dashboard.dashboardId,
      cached,
      durationMs: Math.round(performance.now() - started),
      ...outcome,
    });
  const recordFailure = async (err: unknown, fingerprint: string) => {
    if (progress.unrecorded) return;
    if (!(await claim(caller.userId, fingerprint, windowMinutes))) return;
    const closed = signal?.aborted === true && err === signal.reason;
    try {
      await record({
        ...(closed
          ? { outcome: "failed" as const, errorCode: CLIENT_CLOSED }
          : failureOf(err)),
        rowCount: null,
        truncated: false,
      });
    } catch (recordErr) {
      logger.error(
        { err: recordErr, source_id: progress.sourceId },
        "a failed dashboard run could not be recorded, even without its query"
      );
      await release(caller.userId, fingerprint);
    }
  };

  let planned: Planned;
  try {
    planned = await loadAndPlanSaved(caller, savedQuery, input.body, progress, {
      now: dashboard.now,
    });
  } catch (err) {
    await recordFailure(err, refusalFingerprintOf(savedQuery.id));
    throw err;
  }
  const { plan, catalog } = planned;
  const profile = LIMIT_PROFILES.dashboard;
  const { maxRows } = runLimits("dashboard", plan.limit, catalog.source);
  const fingerprint = fingerprintOf(catalog.source.id, plan, {
    limit: maxRows,
    offset: plan.offset,
  });

  let shown: CachedResult;
  try {
    const hit = await resultCache.get(fingerprint);
    if (hit) {
      cached = true;
      shown = hit;
    } else {
      shown = await coalesce(fingerprint, signal, async () => {
        const result = await runPlanned(input, planned);
        const fresh = shownOf(result, new Date());
        await resultCache.set(
          fingerprint,
          fresh,
          env.DASHBOARD_CACHE_TTL_SECONDS,
          profile.maxBytes
        );
        return fresh;
      });
    }
  } catch (err) {
    // Its own window, so a run that failed (or whose caller went away) never
    // keeps the next successful one from being recorded.
    await recordFailure(err, failureWindowOf(fingerprint));
    throw err;
  }

  const { cached_at: cachedAt, ...rows } = shown;
  const result: DashboardRunResult = {
    ...rows,
    warnings: plan.warnings,
    ...(cached && { cached_at: cachedAt }),
  };
  if (!(await claim(caller.userId, fingerprint, windowMinutes))) return result;
  let runId: string;
  try {
    runId = await record({
      outcome: "ok",
      errorCode: null,
      rowCount: shown.rows.length,
      truncated: shown.truncated,
    });
  } catch (err) {
    logger.error(
      { err, source_id: progress.sourceId },
      "a dashboard run could not be recorded, even without its query; its rows are withheld"
    );
    // The window stays closed, so the next run records instead.
    await release(caller.userId, fingerprint);
    throw err;
  }
  // Not waited for: a stamp that fails is logged, and the run stands.
  void stampSavedQueryRun(savedQuery.id, caller.userId);
  return { ...result, run_id: runId };
};
