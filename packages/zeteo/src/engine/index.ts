import { acquireRunLeases, LEASE_GRACE_MS, runLimits } from "./limits.js";
import { QueryFailedError, ValidationError } from "../utils/errors.js";
import type { VisibleCatalog } from "../grants/visibleCatalog.js";
import { loadVisibleCatalog } from "../grants/visibleCatalog.js";
import { loadAccess, type Access } from "../grants/access.js";
import { withSourceConnection } from "../sources/pools.js";
import { invalidRequest } from "../utils/validateReq.js";
import type { Caller } from "../middleware/auth.js";
import { notFound, QueryError } from "./errors.js";
import { adapterFor } from "../adapters/index.js";
import type { EntryPoint } from "./limits.js";
import { performance } from "node:perf_hooks";
import { logger } from "../utils/logger.js";
import { db } from "../utils/db/index.js";
import { z } from "zod";
import type {
  ColumnType,
  QueryPlan,
  QueryResult,
  QueryWarning,
} from "../adapters/types.js";
import {
  CLIENT_CLOSED,
  failureOf,
  recordRun,
  UNRECORDABLE_QUERY,
} from "./record.js";

export interface RunQueryInput {
  caller: Caller;
  entryPoint: EntryPoint;
  /** The query as the caller sent it. */
  body: unknown;
  /** Aborts when the caller goes away: the run is stopped on the source. */
  signal?: AbortSignal;
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
const sourceSlugOf = (body: unknown): string => {
  const shape = ShapeSchema.safeParse(body);
  if (!shape.success) throw invalidRequest("body", shape.error);
  if (holdsUnstorable(body)) {
    throw new ValidationError(`Invalid request body. ${UNSTORABLE_MESSAGE}`, [
      { path: "", message: UNSTORABLE_MESSAGE },
    ]);
  }
  return shape.data.source;
};

/** What the run has got to, for its record. */
interface Progress {
  sourceId: string | null;
  /** The source's language refused the body: a 400 that is not recorded. */
  unrecorded: boolean;
}

/** Step 3: the planner must reference only granted columns; a miss means it and the catalogue disagree. */
const checkReferences = (
  plan: QueryPlan,
  access: Access,
  catalog: VisibleCatalog
): void => {
  for (const ref of plan.references) {
    if (access.allows(ref.tableId, ref.columnId)) continue;
    logger.error(
      {
        source_id: catalog.source.id,
        table_id: ref.tableId,
        column_id: ref.columnId,
      },
      "a query plan references a column outside the caller's grants"
    );
    throw new QueryError(
      "not_found_or_not_accessible",
      "A name in the query was not found or is not accessible",
      []
    );
  }
};

/** Step 6: the result must be the plan's columns, in order, and every row that wide. */
const checkResult = (
  plan: QueryPlan,
  result: QueryResult,
  sourceId: string
): void => {
  const expected = plan.columns.map(({ name, type }) => ({ name, type }));
  const matches =
    result.columns.length === expected.length &&
    result.columns.every(
      (c, i) => c.name === expected[i].name && c.type === expected[i].type
    ) &&
    result.rows.every(
      (row) => Array.isArray(row) && row.length === expected.length
    );
  if (matches) return;
  logger.error(
    {
      source_id: sourceId,
      expected,
      received: result.columns.map(({ name, type }) => ({ name, type })),
    },
    "a query result does not match its plan"
  );
  throw new QueryFailedError();
};

/** Steps 2 to 6. */
const execute = async (
  { caller, entryPoint, body, signal }: RunQueryInput,
  slug: string,
  progress: Progress
): Promise<{ plan: QueryPlan; result: QueryResult }> => {
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
  const sourceId = catalog.source.id;
  progress.sourceId = sourceId;

  const adapter = adapterFor(catalog.source.type);
  const { language } = adapter;
  const parsed = language.schema.safeParse(body);
  if (!parsed.success) {
    progress.unrecorded = true;
    throw invalidRequest("body", parsed.error);
  }
  const plan = language.plan(parsed.data, catalog);
  checkReferences(plan, access, catalog);

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
  const release = await acquireRunLeases(
    caller.userId,
    sourceId,
    limits.timeoutMs + LEASE_GRACE_MS
  );
  let result: QueryResult;
  try {
    result = await withSourceConnection(sourceId, (conn) =>
      conn.runQuery(prepared, { ...limits, deadlineAt }, signal)
    );
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
  /**
   * Records the run; when the row cannot be stored, records it again with a
   * placeholder for the query, so the run and its audit entry exist either
   * way. Throws only when both attempts fail.
   */
  const record = async (
    outcome: Pick<
      Parameters<typeof recordRun>[0],
      "outcome" | "errorCode" | "rowCount" | "truncated"
    >
  ): Promise<string> => {
    const run = {
      caller: input.caller,
      sourceId: progress.sourceId,
      entryPoint: input.entryPoint,
      query: input.body,
      durationMs: Math.round(performance.now() - started),
      ...outcome,
    };
    try {
      return await recordRun(run);
    } catch (err) {
      logger.error(
        { err, source_id: progress.sourceId },
        "recording a query run failed; recording it without its query"
      );
      return recordRun({ ...run, query: UNRECORDABLE_QUERY });
    }
  };

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
  return {
    columns: result.columns,
    rows: result.rows,
    truncated: result.truncated !== false,
    ...(result.truncated !== false && { truncated_by: result.truncated }),
    warnings: plan.warnings,
    run_id: runId,
  };
};
