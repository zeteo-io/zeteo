// @module-tag int
// @module-tag platform
// @module-tag slow
import { DATA_EXPORT, DATA_READ } from "../../definitions/tereoDeclaration.js";
import { initializeTereo, stopTereo } from "../../utils/tereo.js";
import { auditRows, removeSources } from "../support/sources.js";
import { closeAllSourcePools } from "../../sources/pools.js";
import { describeEachEngine } from "../support/engines.js";
import { recordExportStart } from "../../engine/record.js";
import type { ExportSink } from "../../engine/export.js";
import type { Caller } from "../../middleware/auth.js";
import { leaseKey } from "../../engine/leases.js";
import { redis } from "../../utils/redis.js";
import {
  removePrincipalLimits,
  setPrincipalLimit,
} from "../support/principalLimits.js";
import type {
  OpenLimits,
  PreparedQuery,
  SourceConnection,
} from "../../adapters/types.js";
import {
  abortExports,
  resetExportShutdown,
  runExport,
} from "../../engine/export.js";
import {
  grantTo,
  newQueryUser,
  removeRunsOf,
  runsOf,
  seedQuerySource,
  type SeededSource,
} from "../support/queries.js";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  it,
  vi,
} from "vitest";

// Every row stream the engine opens, and whether its run's signal had aborted
// when it was closed; `onClose`, when a test sets it, runs as one is closed.
const closes = vi.hoisted(() => [] as boolean[]);
const hooks = vi.hoisted(() => ({
  onClose: undefined as (() => void) | undefined,
}));
vi.mock(import("../../sources/pools.js"), async (importOriginal) => {
  const actual = await importOriginal();
  const watched = (conn: SourceConnection): SourceConnection =>
    new Proxy(conn, {
      get(target, prop, receiver) {
        if (prop === "openQuery") {
          return async (
            prepared: PreparedQuery,
            limits: OpenLimits,
            signal?: AbortSignal
          ) => {
            const stream = await target.openQuery(prepared, limits, signal);
            return {
              columns: stream.columns,
              next: (n: number) => stream.next(n),
              close: () => {
                closes.push(signal?.aborted === true);
                hooks.onClose?.();
                return stream.close();
              },
            };
          };
        }
        const value: unknown = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  return {
    ...actual,
    withSourceConnection: <T>(
      sourceId: string,
      fn: (conn: SourceConnection) => Promise<T>
    ) => actual.withSourceConnection(sourceId, (conn) => fn(watched(conn))),
  };
});

// The recorder as the engine sees it, wrapped only when a test says so.
vi.mock(import("../../engine/record.js"), async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, recordExportStart: vi.fn(actual.recordExportStart) };
});

type Call = ["start" | "rows" | "end", unknown];

interface Hooks {
  start?: (head: Parameters<ExportSink["start"]>[0]) => Promise<void> | void;
  rows?: (batch: unknown[][]) => Promise<void> | void;
}

/** A sink that records every call, then runs the hook for it. */
const recorder = (hooks: Hooks = {}) => {
  const calls: Call[] = [];
  const sink: ExportSink = {
    start: async (head) => {
      calls.push(["start", head]);
      await hooks.start?.(head);
    },
    rows: async (batch) => {
      calls.push(["rows", batch]);
      await hooks.rows?.(batch);
    },
    end: async (tail) => {
      calls.push(["end", tail]);
    },
  };
  const rows = () =>
    calls
      .filter(([kind]) => kind === "rows")
      .flatMap(([, b]) => b as unknown[][]);
  return { sink, calls, rows };
};

const rejectionOf = async (promise: Promise<unknown>): Promise<Error> => {
  try {
    await promise;
  } catch (err) {
    return err as Error;
  }
  throw new Error("the export succeeded");
};

const CUSTOMERS = [
  [1, "Acme"],
  [2, "100% Organic_Foods"],
  [3, "MiXeD Case Ltd"],
];

describeEachEngine("runExport", (engine) => {
  let source: SeededSource;
  let capped: SeededSource;
  let off: SeededSource;
  let zeroCap: SeededSource;
  /** Runs one export at a time. */
  let single: SeededSource;
  const users: string[] = [];

  const callerOf = (userId: string): Caller => ({
    userId,
    organizationId: null,
    permissions: [DATA_READ, DATA_EXPORT],
    isServiceAccount: false,
  });

  /** A caller granted customers (all of it, or these columns) and slow_orders on every source. */
  const grantedCaller = async (
    columns: string[] | "all" = "all"
  ): Promise<Caller> => {
    const user = newQueryUser();
    users.push(user.id);
    for (const on of [source, capped, off, zeroCap, single]) {
      await grantTo(user.principal, on.tables.customers!, columns);
      await grantTo(user.principal, on.tables.slow_orders!, "all");
    }
    return callerOf(user.id);
  };

  const customers = (on: SeededSource, extra: object = {}) => ({
    source: on.slug,
    from: "customers",
    select: ["id", "name"],
    ...extra,
  });

  const onlyRunOf = async (userId: string) => {
    const runs = await runsOf([userId]);
    expect(runs).toHaveLength(1);
    return runs[0]!;
  };

  /** The export leases still held after up to a second: the release is not waited for. */
  const leasesHeld = async (caller: Caller, on: SeededSource) => {
    const held = async () =>
      (await redis.zcard(leaseKey(`export:user:${caller.userId}`))) +
      (await redis.zcard(leaseKey(`export:source:${on.id}`)));
    const until = Date.now() + 1000;
    while ((await held()) > 0 && Date.now() < until) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return held();
  };

  /** Resolves once `fn` is called; `fn` waits until the returned gate opens. */
  const gate = () => {
    let open!: () => void;
    const opened = new Promise<void>((resolve) => {
      open = resolve;
    });
    let reached!: () => void;
    const reachedP = new Promise<void>((resolve) => {
      reached = resolve;
    });
    return {
      wait: async () => {
        reached();
        await opened;
      },
      reached: reachedP,
      open,
    };
  };

  beforeAll(async () => {
    await initializeTereo();
    const exportable = { export_enabled: true, export_row_cap: 1_000_000 };
    source = await seedQuerySource(
      engine,
      { ...exportable, export_concurrency: 2 },
      "export"
    );
    single = await seedQuerySource(
      engine,
      { ...exportable, export_concurrency: 1 },
      "export"
    );
    capped = await seedQuerySource(
      engine,
      { export_enabled: true, export_row_cap: 2 },
      "export"
    );
    off = await seedQuerySource(engine, {}, "export");
    zeroCap = await seedQuerySource(
      engine,
      { export_enabled: true, export_row_cap: 0 },
      "export"
    );
  });
  beforeEach(() => {
    closes.length = 0;
    hooks.onClose = undefined;
  });
  // abortExports refuses every later export in the process.
  afterEach(() => resetExportShutdown());
  afterAll(async () => {
    await closeAllSourcePools();
    await removePrincipalLimits(users);
    await removeRunsOf(users);
    await removeSources([source.id, capped.id, off.id, zeroCap.id, single.id]);
    await stopTereo();
  });

  it("passes every row to the sink between start and end, and records the run and both audit entries", async () => {
    const caller = await grantedCaller();
    let seenAtStart: unknown;
    const { sink, calls, rows } = recorder({
      start: async () => {
        seenAtStart = (await onlyRunOf(caller.userId)).outcome;
      },
    });
    const body = customers(source);
    await runExport(
      { caller, body, signal: new AbortController().signal },
      sink
    );

    expect(calls[0]![0]).toBe("start");
    const run = await onlyRunOf(caller.userId);
    expect(calls[0]![1]).toEqual({
      columns: [
        { name: "id", type: "number" },
        { name: "name", type: "text" },
      ],
      warnings: [],
      runId: run.id,
    });
    expect(seenAtStart).toBe("running");
    expect(rows()).toEqual(CUSTOMERS);
    expect(calls.at(-1)).toEqual(["end", { status: "complete", rows: 3 }]);
    expect(calls.slice(1, -1).every(([kind]) => kind === "rows")).toBe(true);

    expect(run).toMatchObject({
      userId: caller.userId,
      sourceId: source.id,
      entryPoint: "export",
      query: body,
      rowCount: 3,
      outcome: "ok",
      errorCode: null,
      truncated: false,
    });
    const audit = (await auditRows(run.id)).map((r) => r.payload);
    expect(audit.map((a) => [a.metadata.event, a.action])).toEqual([
      ["zeteo.export.started", "CREATE"],
      ["zeteo.export.run", "UPDATE"],
    ]);
    expect(audit[0]).toMatchObject({
      entityType: "query_run",
      entityId: run.id,
      userId: caller.userId,
      metadata: { source_id: source.id, entry_point: "export" },
    });
    expect(Object.keys(audit[0]!.metadata).sort()).toEqual([
      "entry_point",
      "event",
      "source_id",
    ]);
    expect(audit[1]!.metadata).toEqual({
      event: "zeteo.export.run",
      source_id: source.id,
      entry_point: "export",
      outcome: "ok",
      error_code: null,
      row_count: 3,
      duration_ms: run.durationMs,
    });
    expect(JSON.stringify([run, audit])).not.toContain("Acme");
    expect(await leasesHeld(caller, source)).toBe(0);
  });

  it("stops at the source's export cap and says the export was truncated", async () => {
    const caller = await grantedCaller();
    const { sink, calls, rows } = recorder();
    await runExport(
      { caller, body: customers(capped), signal: new AbortController().signal },
      sink
    );
    expect(rows()).toEqual(CUSTOMERS.slice(0, 2));
    expect(calls.at(-1)).toEqual(["end", { status: "truncated", rows: 2 }]);
    expect(await onlyRunOf(caller.userId)).toMatchObject({
      outcome: "ok",
      rowCount: 2,
      truncated: true,
    });
    // Ended early: the run was stopped before its stream was closed.
    expect(closes).toEqual([true]);
  });

  it("refuses with 403 export_not_enabled when the source's exports are off or capped at 0, and records the refusal", async () => {
    for (const on of [off, zeroCap]) {
      const caller = await grantedCaller();
      const { sink, calls } = recorder();
      const err = await rejectionOf(
        runExport(
          { caller, body: customers(on), signal: new AbortController().signal },
          sink
        )
      );
      expect(err).toMatchObject({
        statusCode: 403,
        code: "export_not_enabled",
      });
      expect(calls).toEqual([]);
      const run = await onlyRunOf(caller.userId);
      expect(run).toMatchObject({
        sourceId: on.id,
        entryPoint: "export",
        outcome: "refused",
        errorCode: "export_not_enabled",
        rowCount: null,
      });
      const audit = await auditRows(run.id);
      // The entry creates the run: the export never started.
      expect(
        audit.map((a) => [a.payload.metadata.event, a.payload.action])
      ).toEqual([["zeteo.export.run", "CREATE"]]);
    }
  });

  it("answers not_found_or_not_accessible, not export_not_enabled, for a source the caller cannot see", async () => {
    const user = newQueryUser();
    users.push(user.id);
    const caller = callerOf(user.id);
    const err = await rejectionOf(
      runExport(
        { caller, body: customers(off), signal: new AbortController().signal },
        recorder().sink
      )
    );
    expect(err).toMatchObject({
      statusCode: 422,
      code: "not_found_or_not_accessible",
    });
  });

  it("refuses an ungranted column exactly as a nonexistent one", async () => {
    const caller = await grantedCaller(["id", "name"]);
    const signal = new AbortController().signal;
    const hidden = await rejectionOf(
      runExport(
        {
          caller,
          body: customers(source, { select: ["id", "email"] }),
          signal,
        },
        recorder().sink
      )
    );
    const missing = await rejectionOf(
      runExport(
        {
          caller,
          body: customers(source, { select: ["id", "emial"] }),
          signal,
        },
        recorder().sink
      )
    );
    const shape = (err: Error) => {
      const e = err as Error & {
        statusCode: number;
        code: string;
        path: unknown;
        suggestions: unknown;
      };
      return {
        status: e.statusCode,
        code: e.code,
        message: e.message.replace(/"[^"]*"/, '"…"'),
        path: e.path,
        suggestions: e.suggestions,
      };
    };
    expect(shape(hidden)).toEqual(shape(missing));
    expect(shape(hidden)).toMatchObject({
      status: 422,
      code: "not_found_or_not_accessible",
    });
  });

  it("refuses a second export by the same user with 429 too_many_exports while the first runs, when their limit is 1", async () => {
    const caller = await grantedCaller();
    const userLimits = { queryConcurrency: 5, exportConcurrency: 1 };
    const held = gate();
    const first = runExport(
      {
        caller,
        body: customers(source),
        signal: new AbortController().signal,
        userLimits,
      },
      recorder({ rows: held.wait }).sink
    );
    try {
      await held.reached;
      const err = await rejectionOf(
        runExport(
          {
            caller,
            body: customers(source),
            signal: new AbortController().signal,
            userLimits,
          },
          recorder().sink
        )
      );
      expect(err).toMatchObject({
        statusCode: 429,
        code: "too_many_exports",
        message: "At most 1 export may run at once for one user",
      });
    } finally {
      held.open();
      await first;
    }
    const runs = await runsOf([caller.userId]);
    expect(runs.map((r) => [r.outcome, r.errorCode]).sort()).toEqual([
      ["ok", null],
      ["refused", "too_many_exports"],
    ]);
  });

  it("runs two exports by one user at once when their own row sets export_concurrency 2", async () => {
    const caller = await grantedCaller();
    await setPrincipalLimit(
      { type: "user", id: caller.userId },
      { export_concurrency: 2 }
    );
    const gates = [gate(), gate()];
    const running = gates.map((g) =>
      runExport(
        {
          caller,
          body: customers(source),
          signal: new AbortController().signal,
        },
        recorder({ rows: g.wait }).sink
      )
    );
    // Under the default of 1 the second is refused: fail on that, not hang.
    const refused = new Promise<never>((_, reject) => {
      for (const run of running) run.catch(reject);
    });
    await Promise.race([Promise.all(gates.map((g) => g.reached)), refused]);
    for (const g of gates) g.open();
    await Promise.all(running);
    const runs = await runsOf([caller.userId]);
    expect(runs.map((r) => r.outcome)).toEqual(["ok", "ok"]);
  });

  it("refuses a second export by another user with 429 source_busy on a source with export_concurrency 1", async () => {
    const holder = await grantedCaller();
    const held = gate();
    const first = runExport(
      {
        caller: holder,
        body: customers(single),
        signal: new AbortController().signal,
      },
      recorder({ rows: held.wait }).sink
    );
    try {
      await held.reached;
      const other = await grantedCaller();
      const err = await rejectionOf(
        runExport(
          {
            caller: other,
            body: customers(single),
            signal: new AbortController().signal,
          },
          recorder().sink
        )
      );
      expect(err).toMatchObject({
        statusCode: 429,
        code: "source_busy",
        message: "The source runs at most 1 export at once; retry shortly",
      });
    } finally {
      held.open();
      await first;
    }
  });

  it("refuses a third export on a source with export_concurrency 2 with 429 source_busy while two run", async () => {
    const holders = [await grantedCaller(), await grantedCaller()];
    const gates = holders.map(() => gate());
    const running = holders.map((caller, i) =>
      runExport(
        {
          caller,
          body: customers(source),
          signal: new AbortController().signal,
        },
        recorder({ rows: gates[i]!.wait }).sink
      )
    );
    try {
      await Promise.all(gates.map((g) => g.reached));
      const third = await grantedCaller();
      const err = await rejectionOf(
        runExport(
          {
            caller: third,
            body: customers(source),
            signal: new AbortController().signal,
          },
          recorder().sink
        )
      );
      expect(err).toMatchObject({ statusCode: 429, code: "source_busy" });
      expect(await onlyRunOf(third.userId)).toMatchObject({
        outcome: "refused",
        errorCode: "source_busy",
      });
    } finally {
      for (const g of gates) g.open();
      await Promise.all(running);
    }
  });

  it("ends at the deadline while the sink takes no rows, recorded as a timeout, its leases freed", async () => {
    const caller = await grantedCaller();
    const { sink, calls } = recorder({ rows: () => new Promise(() => {}) });
    const began = Date.now();
    const err = await rejectionOf(
      runExport(
        {
          caller,
          body: customers(source),
          signal: new AbortController().signal,
        },
        sink,
        { timeoutMs: 2000 }
      )
    );
    expect(Date.now() - began).toBeLessThan(4000);
    expect(err).toMatchObject({ statusCode: 504, code: "query_timeout" });
    expect(calls.some(([kind]) => kind === "end")).toBe(false);
    const run = await onlyRunOf(caller.userId);
    expect(run).toMatchObject({
      outcome: "timeout",
      errorCode: "query_timeout",
      rowCount: (calls.filter(([k]) => k === "rows")[0]![1] as unknown[])
        .length,
    });
    expect(closes).toEqual([true]);
    expect(await leasesHeld(caller, source)).toBe(0);
    const audit = await auditRows(run.id);
    expect(audit.map((a) => a.payload.metadata.event)).toEqual([
      "zeteo.export.started",
      "zeteo.export.run",
    ]);
  });

  it("records a caller that went away after the start as client_closed", async () => {
    const caller = await grantedCaller();
    const controller = new AbortController();
    const { sink, calls } = recorder({ start: () => controller.abort() });
    const err = await rejectionOf(
      runExport(
        { caller, body: customers(source), signal: controller.signal },
        sink
      )
    );
    expect(err).toBe(controller.signal.reason);
    expect(calls.map(([kind]) => kind)).toEqual(["start"]);
    expect(await onlyRunOf(caller.userId)).toMatchObject({
      outcome: "failed",
      errorCode: "client_closed",
      rowCount: 0,
    });
    expect(closes).toEqual([true]);
    expect(await leasesHeld(caller, source)).toBe(0);
  });

  it("records a sink that fails as failed and stops the statement on the source", async () => {
    const caller = await grantedCaller();
    const broken = new Error("socket gone");
    const { sink } = recorder({
      rows: () => {
        throw broken;
      },
    });
    const err = await rejectionOf(
      runExport(
        {
          caller,
          body: { source: source.slug, from: "slow_orders", select: ["id"] },
          signal: new AbortController().signal,
        },
        sink
      )
    );
    expect(err).toBe(broken);
    const run = await onlyRunOf(caller.userId);
    expect(run).toMatchObject({ outcome: "failed", errorCode: "server_error" });
    expect(run.rowCount).toBeGreaterThan(0);
    expect(closes).toEqual([true]);
    expect(await engine.runningOn("slow_orders")).toBe(0);
    expect(await leasesHeld(caller, source)).toBe(0);
  });

  it("records an export stopped by abortExports as shutting_down", async () => {
    const caller = await grantedCaller();
    const { sink } = recorder({ start: () => abortExports() });
    const err = await rejectionOf(
      runExport(
        {
          caller,
          body: customers(source),
          signal: new AbortController().signal,
        },
        sink
      )
    );
    expect(err).toMatchObject({ statusCode: 503 });
    expect(await onlyRunOf(caller.userId)).toMatchObject({
      outcome: "failed",
      errorCode: "shutting_down",
    });
    expect(closes).toEqual([true]);
  });

  it("does not end the sink of an export halted after its last rows, and records the halt", async () => {
    const caller = await grantedCaller();
    const { sink, calls, rows } = recorder();
    hooks.onClose = () => abortExports();
    const err = await rejectionOf(
      runExport(
        {
          caller,
          body: customers(source),
          signal: new AbortController().signal,
        },
        sink
      )
    );
    expect(err).toMatchObject({ statusCode: 503 });
    expect(rows()).toEqual(CUSTOMERS);
    expect(calls.some(([kind]) => kind === "end")).toBe(false);
    const run = await onlyRunOf(caller.userId);
    expect(run).toMatchObject({
      outcome: "failed",
      errorCode: "shutting_down",
      rowCount: 3,
      truncated: false,
    });
    const audit = await auditRows(run.id);
    expect(audit.map((a) => a.payload.metadata.event)).toEqual([
      "zeteo.export.started",
      "zeteo.export.run",
    ]);
    expect(await leasesHeld(caller, source)).toBe(0);
  });

  it("does not start the sink of an export halted while its start is recorded, and records the halt", async () => {
    const caller = await grantedCaller();
    const actual = await vi.importActual<
      typeof import("../../engine/record.js")
    >("../../engine/record.js");
    vi.mocked(recordExportStart).mockImplementationOnce(async (start) => {
      const id = await actual.recordExportStart(start);
      abortExports();
      return id;
    });
    const { sink, calls } = recorder();
    const err = await rejectionOf(
      runExport(
        {
          caller,
          body: customers(source),
          signal: new AbortController().signal,
        },
        sink
      )
    );
    expect(err).toMatchObject({ statusCode: 503 });
    expect(calls).toEqual([]);
    const run = await onlyRunOf(caller.userId);
    expect(run).toMatchObject({
      outcome: "failed",
      errorCode: "shutting_down",
      rowCount: 0,
    });
    const audit = await auditRows(run.id);
    expect(
      audit.map((a) => [a.payload.metadata.event, a.payload.action])
    ).toEqual([
      ["zeteo.export.started", "CREATE"],
      ["zeteo.export.run", "UPDATE"],
    ]);
    expect(closes).toEqual([true]);
  });
  it("refuses a new export with 503 once abortExports has been called, recording nothing and taking no lease", async () => {
    abortExports();
    const caller = await grantedCaller();
    const { sink, calls } = recorder();
    const err = await rejectionOf(
      runExport(
        {
          caller,
          body: customers(source),
          signal: new AbortController().signal,
        },
        sink
      )
    );
    expect(err).toMatchObject({
      statusCode: 503,
      code: "temporarily_unavailable",
      message: "The service is shutting down",
    });
    expect(calls).toEqual([]);
    expect(closes).toEqual([]);
    expect(await runsOf([caller.userId])).toEqual([]);
    expect(await leasesHeld(caller, source)).toBe(0);

    resetExportShutdown();
    await runExport(
      { caller, body: customers(source), signal: new AbortController().signal },
      recorder().sink
    );
    expect(await onlyRunOf(caller.userId)).toMatchObject({ outcome: "ok" });
  });
});
