import { QueryFailedError, ValidationError } from "../utils/errors.js";
import { loadAccess, type CallerAccess } from "../grants/access.js";
import type { VisibleCatalog } from "../grants/visibleCatalog.js";
import { planSaved, type SavedQueryToPlan } from "./savedPlan.js";
import { loadVisibleCatalog } from "../grants/visibleCatalog.js";
import { stampSavedQueryRun } from "../saved-queries/stamps.js";
import { withSourceConnection } from "../sources/pools.js";
import { invalidRequest } from "../utils/validateReq.js";
import { loadUserLimits } from "../limits/resolve.js";
import type { Caller } from "../middleware/auth.js";
import { planFor, type Progress } from "./plan.js";
import type { QueryEntryPoint } from "./limits.js";
import { performance } from "node:perf_hooks";
import { logger } from "../utils/logger.js";
import { db } from "../utils/db/index.js";
import { notFound } from "./errors.js";
import { collect } from "./collect.js";
import { z } from "zod";
import type {
  ColumnType,
  QueryPlan,
  QueryResult,
  QueryWarning,
  SourceAdapter,
} from "../adapters/types.js";
import {
  acquireRunLeases,
  LEASE_GRACE_MS,
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
  progress: Progress
): Promise<{
  access: CallerAccess;
  catalog: VisibleCatalog;
  adapter: SourceAdapter;
  plan: QueryPlan;
}> => {
  const access = await loadAccess(caller);
  const toPlan: SavedQueryToPlan = {
    sourceId: saved.sourceId,
    query: body as SavedQueryToPlan["query"],
  };
  return { access, ...(await planSaved(access, toPlan, progress)) };
};

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
  { caller, entryPoint, body, signal, userLimits, savedQuery }: RunQueryInput,
  slug: string,
  progress: Progress
): Promise<{ plan: QueryPlan; result: QueryResult }> => {
  const { access, catalog, adapter, plan } = savedQuery
    ? await loadAndPlanSaved(caller, savedQuery, body, progress)
    : await loadCatalogFor(caller, slug, progress).then((loaded) => ({
        ...loaded,
        ...planFor(body, loaded.access, loaded.catalog, progress),
      }));
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
  const release = await acquireRunLeases(
    caller.userId,
    catalog.source,
    limits.timeoutMs + LEASE_GRACE_MS,
    ownLimits
  );
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
  return { plan, result };
};

/**
 * Runs one query from any entry point: checks its shape, resolves its source
 * and plans it against what the caller may see, runs it within the entry
 * point's limits, and records it. Every query past the shape check is
 * recorded, refused and failed ones included; rows are returned only once
 * their run is recorded.
 */
export const runQuery = async (
  input: RunQueryInput
): Promise<RunQueryResult> => {
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
};
