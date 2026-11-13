// @module-tag int
// @module-tag platform
import { AzureSqlConnection } from "../../../adapters/azure-sql/connect.js";
import { toMssqlConfig } from "../../../adapters/azure-sql/settings.js";
import { mssqlDialect } from "../../../adapters/sql/dialects/mssql.js";
import type { SqlPlan } from "../../../adapters/sql/types.js";
import { compileSql } from "../../../adapters/sql/compile.js";
import { QueryError } from "../../../engine/errors.js";
import { describe, expect, it, vi } from "vitest";
import type { Socket } from "node:net";
import sql from "mssql";
import {
  mssqlFixtureSettings,
  mssqlFixtureTarget,
} from "../../support/mssqlFixture.js";
import {
  LIMITS,
  OPTIONS,
  failureOf,
  kill,
  runningOn,
  useMssqlRuns,
  waitFor,
} from "../../support/mssqlRuns.js";
import {
  QueryFailedError,
  QueryTimeoutError,
  ServiceUnavailableError,
  SourceUnreachableError,
} from "../../../utils/errors.js";

const runs = useMssqlRuns();
const { connectWith, plan, run } = runs;

const accountIds = [[1], [2]];

describe("azure-sql runQuery: safety", () => {
  it("sends the compiled SELECT, and nothing else, as one request with typed parameters", async () => {
    const query = vi.spyOn(sql.Request.prototype, "query");
    const input = vi.spyOn(sql.Request.prototype, "input");
    const batch = vi.spyOn(sql.Request.prototype, "batch");
    const planned = plan({
      from: "orders",
      select: ["id"],
      where: { status: { eq: "paid" }, total: { gt: "100.5" } },
    });
    await runs.connection().runQuery(planned, { ...LIMITS, maxRows: 3 });
    const compiled = compileSql(planned, mssqlDialect, {
      limit: 4,
      offset: 0,
    });
    expect(query.mock.calls.map(([text]) => text)).toEqual([compiled.sql]);
    expect(batch).not.toHaveBeenCalled();
    const declared = (type: unknown) => {
      const t = type as {
        declaration?: string;
        type?: { declaration: string };
      };
      return t.declaration ?? t.type!.declaration;
    };
    expect(
      input.mock.calls.map(([name, type, value]) => [
        name,
        declared(type),
        value,
      ])
    ).toEqual([
      ["1", "nvarchar", "paid"],
      ["2", "nvarchar", "100.5"],
      ["3", "bigint", "0"],
      ["4", "bigint", "4"],
    ]);
  });

  it("stops a query past its time limit with query_timeout, at its own deadline, and keeps the connection usable", async () => {
    const begun = Date.now();
    const err = await failureOf(
      run({ from: "slow_orders", select: ["id"] }, { timeoutMs: 500 })
    );
    expect(err).toBeInstanceOf(QueryTimeoutError);
    // The driver's own request timeout is two seconds later.
    expect(Date.now() - begun).toBeLessThan(1500);
    expect(await runningOn("slow_orders")).toEqual([]);
    expect((await run({ from: "accounts", select: ["id"] })).rows).toEqual(
      accountIds
    );
  });

  it("stops at the driver's request timeout when its own cancel does nothing", async () => {
    vi.spyOn(sql.Request.prototype, "cancel").mockImplementation(
      () => undefined
    );
    const begun = Date.now();
    const err = await failureOf(
      run({ from: "slow_orders", select: ["id"] }, { timeoutMs: 300 })
    );
    expect(err).toBeInstanceOf(QueryTimeoutError);
    expect(Date.now() - begun).toBeLessThan(2900);
    expect(await runningOn("slow_orders")).toEqual([]);
  });

  it("lets a query run past the pool's own request timeout when its limit is longer", async () => {
    const short = await connectWith({ ...OPTIONS, queryTimeoutMs: 1000 });
    const result = await run(
      { from: "slow_orders", select: ["id"], limit: 1 },
      { timeoutMs: 6000, maxRows: 1 },
      short
    );
    expect(result.rows).toEqual([[1]]);
  });

  it("answers a failing query with query_failed and none of the database's text", async () => {
    const err = await failureOf(
      run({ from: "broken_orders", select: ["ratio"] })
    );
    expect(err).toBeInstanceOf(QueryFailedError);
    expect(err.message).toBe("The source could not run the query");
    expect(JSON.stringify(err)).not.toMatch(/divide|zero|8134/i);
    expect((await run({ from: "accounts", select: ["id"] })).rows).toEqual(
      accountIds
    );
  });

  it.each([
    [
      "a datetime bound before 1753 (242)",
      "legacy_times",
      { legacy: { gt: "1000-01-01T00:00:00Z" } },
    ],
    [
      "an offset SQL Server does not take (241)",
      "legacy_times",
      { legacy: { gt: "2026-01-01T00:00:00+14:30" } },
    ],
    [
      "a timestamp that leaves datetime2's range in UTC (8114)",
      "legacy_times",
      { minute: { lt: "9999-12-31T23:00:00-05:00" } },
    ],
    [
      "a malformed uniqueidentifier (8169)",
      "typed_values",
      { guid: { in: ["6F1C1B2E-3C4D-4E5F-8A9B-0C1D2E3F4A5B", "nope"] } },
    ],
  ])(
    "refuses %s as the caller's value: 422 invalid_value, none of the database's text",
    async (_, from, where) => {
      const err = await failureOf(run({ from, select: ["id"], where }));
      expect(err).toBeInstanceOf(QueryError);
      expect(err).toMatchObject({
        statusCode: 422,
        code: "invalid_value",
        message:
          "A value in the query could not be converted to its column's type",
        path: [],
      });
      expect(JSON.stringify(err)).not.toMatch(/conver|range|uniqueidentifier/i);
    }
  );

  it("refuses a result whose columns are not the plan's", async () => {
    const planned = plan({ from: "accounts", select: ["id"] });
    const widened = {
      ...planned,
      columns: [...planned.columns, planned.columns[0]],
    };
    const err = await failureOf(runs.connection().runQuery(widened, LIMITS));
    expect(err).toBeInstanceOf(QueryFailedError);
    expect((await run({ from: "accounts", select: ["id"] })).rows).toEqual(
      accountIds
    );
  });

  it("cancels the statement on the source when the signal aborts", async () => {
    const controller = new AbortController();
    const begun = Date.now();
    const running = runs
      .connection()
      .runQuery(
        plan({ from: "slow_orders", select: ["id"] }),
        { ...LIMITS, timeoutMs: 10_000 },
        controller.signal
      );
    await waitFor(() => runningOn("slow_orders"));
    controller.abort(new Error("client went away"));
    const err = await failureOf(running);
    expect(err.message).toBe("client went away");
    expect(Date.now() - begun).toBeLessThan(2500);
    expect(await runningOn("slow_orders")).toEqual([]);
    expect((await run({ from: "accounts", select: ["id"] })).rows).toEqual(
      accountIds
    );
  });

  it("cancels an aborted statement while every pool connection is in use", async () => {
    const full = await connectWith({ ...OPTIONS, poolSize: 2 });
    const first = new AbortController();
    const second = new AbortController();
    const slow = plan({ from: "slow_orders", select: ["id"] });
    const limits = { ...LIMITS, timeoutMs: 10_000 };
    const one = failureOf(full.runQuery(slow, limits, first.signal));
    const two = failureOf(full.runQuery(slow, limits, second.signal));
    await waitFor(async () =>
      (await runningOn("slow_orders")).length === 2 ? [true] : []
    );
    const begun = Date.now();
    first.abort(new Error("first gone"));
    expect((await one).message).toBe("first gone");
    expect(Date.now() - begun).toBeLessThan(1000);
    expect(await runningOn("slow_orders")).toHaveLength(1);
    second.abort(new Error("second gone"));
    expect((await two).message).toBe("second gone");
    expect(await runningOn("slow_orders")).toEqual([]);
  });

  it("leaves a cancelled connection clean for the next request", async () => {
    const single = (await connectWith({
      ...OPTIONS,
      poolSize: 1,
    })) as AzureSqlConnection;
    const before = await single.pool.request().query("SELECT @@SPID AS spid");
    const err = await failureOf(
      run({ from: "slow_orders", select: ["id"] }, { timeoutMs: 300 }, single)
    );
    expect(err).toBeInstanceOf(QueryTimeoutError);
    const after = await single.pool
      .request()
      .query("SELECT @@SPID AS spid, @@TRANCOUNT AS open_transactions");
    expect(after.recordset).toEqual([
      { spid: before.recordset[0].spid, open_transactions: 0 },
    ]);
    expect(
      (await run({ from: "accounts", select: ["id"] }, {}, single)).rows
    ).toEqual(accountIds);
  });

  it("refuses a query with more parameters than SQL Server takes before sending anything", async () => {
    const query = vi.spyOn(sql.Request.prototype, "query");
    const list = (from: number) =>
      Array.from({ length: 800 }, (_, i) => from + i);
    const err = await failureOf(
      run({
        from: "orders",
        select: ["id"],
        where: {
          or: [
            { id: { in: list(0) } },
            { id: { in: list(1000) } },
            { id: { in: list(2000) } },
          ],
        },
      })
    );
    expect(err).toBeInstanceOf(QueryError);
    expect(err).toMatchObject({
      statusCode: 422,
      code: "too_many_parameters",
      path: [],
    });
    expect(query).not.toHaveBeenCalled();
  });

  it("answers 503, busy, when no pool connection frees up in time", async () => {
    const single = await connectWith({
      ...OPTIONS,
      connectTimeoutMs: 1000,
      poolSize: 1,
    });
    const controller = new AbortController();
    const slow = failureOf(
      single.runQuery(
        plan({ from: "slow_orders", select: ["id"] }),
        { ...LIMITS, timeoutMs: 10_000 },
        controller.signal
      )
    );
    await waitFor(() => runningOn("slow_orders"));
    const begun = Date.now();
    const err = await failureOf(
      run({ from: "accounts", select: ["id"] }, {}, single)
    );
    expect(err).toBeInstanceOf(ServiceUnavailableError);
    expect(err).toMatchObject({ statusCode: 503 });
    expect(Date.now() - begun).toBeLessThan(2000);
    controller.abort(new Error("done"));
    expect((await slow).message).toBe("done");
  });

  it.each([
    [
      "its request timeout",
      () =>
        new sql.RequestError(
          "Timeout: Request failed to complete in 2300ms",
          "ETIMEOUT"
        ),
    ],
    [
      "a cancel the server never acknowledged, which closed the connection",
      () =>
        new sql.RequestError(
          Object.assign(new Error("Failed to cancel request in 2000ms"), {
            name: "ConnectionError",
            code: "ETIMEOUT",
          }),
          "EREQUEST"
        ),
    ],
  ])("answers query_timeout when the driver reports %s", async (_, error) => {
    vi.spyOn(sql.Request.prototype, "query").mockImplementation(function (
      this: sql.Request,
      _text: unknown,
      callback?: unknown
    ) {
      setImmediate(() => {
        this.emit("error", error());
        (callback as () => void)();
      });
      return this;
    } as never);
    const err = await failureOf(run({ from: "accounts", select: ["id"] }));
    expect(err).toBeInstanceOf(QueryTimeoutError);
  });

  it("answers source_unreachable when the pool cannot open a connection in time", async () => {
    vi.spyOn(sql.Request.prototype, "query").mockImplementation(function (
      this: sql.Request,
      _text: unknown,
      callback?: unknown
    ) {
      setImmediate(() => {
        this.emit(
          "error",
          new sql.ConnectionError("Failed to connect in 1000ms", "ETIMEOUT")
        );
        (callback as () => void)();
      });
      return this;
    } as never);
    const err = await failureOf(run({ from: "accounts", select: ["id"] }));
    expect(err).toBeInstanceOf(SourceUnreachableError);
  });

  it("times out, and drops the connection, when the server never acknowledges the cancel", async () => {
    const sockets: Socket[] = [];
    const config = toMssqlConfig(
      mssqlFixtureSettings("ro"),
      await mssqlFixtureTarget(),
      { ...OPTIONS, poolSize: 1 }
    );
    const connector = config.options!.connector as unknown as (
      ...args: unknown[]
    ) => Promise<Socket>;
    const single = (await runs.connectWithDriverOptions(
      {
        cancelTimeout: 300,
        connector: (async (...args: unknown[]) => {
          const socket = await connector(...args);
          sockets.push(socket);
          return socket;
        }) as never,
      },
      { ...OPTIONS, poolSize: 1 }
    )) as AzureSqlConnection;
    await single.pool.request().query("SET CONTEXT_INFO 0x7a");
    const running = failureOf(
      run({ from: "slow_orders", select: ["id"] }, { timeoutMs: 600 }, single)
    );
    await waitFor(() => runningOn("slow_orders"));
    // Nothing the server sends is read any more, its acknowledgement included.
    for (const socket of sockets) socket.pause();
    const begun = Date.now();
    expect(await running).toBeInstanceOf(QueryTimeoutError);
    expect(Date.now() - begun).toBeLessThan(1500);
    const after = await single.pool
      .request()
      .query("SELECT CONTEXT_INFO() AS mark");
    expect(after.recordset).toEqual([{ mark: null }]);
  });

  it("answers query_failed, not source_unreachable, for a value the driver cannot bind", async () => {
    const planned = plan({
      from: "accounts",
      select: ["id"],
      where: { id: { eq: 1 } },
    });
    const where = planned.where;
    if (where?.kind !== "compare") throw new Error("expected a comparison");
    const err = await failureOf(
      runs.connection().runQuery(
        {
          ...planned,
          where: {
            ...where,
            subject: { ...where.subject, type: "boolean" },
            value: {
              valueOf: () => {
                throw new Error("cannot bind");
              },
            } as never,
          },
        } as SqlPlan,
        LIMITS
      )
    );
    expect(err).toBeInstanceOf(QueryFailedError);
    expect((await run({ from: "accounts", select: ["id"] })).rows).toEqual(
      accountIds
    );
  });

  it("runs nothing for a signal that has already aborted", async () => {
    const query = vi.spyOn(sql.Request.prototype, "query");
    const controller = new AbortController();
    controller.abort(new Error("gone"));
    const err = await failureOf(
      runs
        .connection()
        .runQuery(
          plan({ from: "slow_orders", select: ["id"] }),
          LIMITS,
          controller.signal
        )
    );
    expect(err.message).toBe("gone");
    expect(query).not.toHaveBeenCalled();
  });

  it("answers source_unreachable when the server drops the connection mid-query", async () => {
    const running = failureOf(
      run({ from: "slow_orders", select: ["id"] }, { timeoutMs: 10_000 })
    );
    const [{ session_id }] = await waitFor(() => runningOn("slow_orders"));
    await kill(session_id);
    expect(await running).toBeInstanceOf(SourceUnreachableError);
    expect((await run({ from: "accounts", select: ["id"] })).rows).toEqual(
      accountIds
    );
  });

  it("answers source_unreachable when the connection is lost mid-read, and drops it", async () => {
    const single = (await connectWith({
      ...OPTIONS,
      poolSize: 1,
    })) as AzureSqlConnection;
    // A mark on the session: a new connection has none.
    const before = await single.pool
      .request()
      .query("SET CONTEXT_INFO 0x7a; SELECT @@SPID AS spid");
    const spid = before.recordset[0].spid as number;
    let rows = 0;
    let killed: Promise<unknown> | undefined;
    const emit = sql.Request.prototype.emit;
    vi.spyOn(sql.Request.prototype, "emit").mockImplementation(function (
      this: sql.Request,
      event: string | symbol,
      ...args: unknown[]
    ) {
      if (event === "row" && ++rows === 1) killed = kill(spid);
      return emit.call(this, event, ...args);
    });
    const err = await failureOf(
      run(
        {
          from: "wide_rows",
          select: ["id", "filler"],
          orderBy: [{ id: "asc" }],
        },
        { maxRows: 50_000, maxBytes: 500 * 1024 * 1024 },
        single
      )
    );
    await killed;
    expect(err).toBeInstanceOf(SourceUnreachableError);
    expect(rows).toBeGreaterThan(0);
    expect(rows).toBeLessThan(50_000);
    vi.restoreAllMocks();
    const after = await single.pool
      .request()
      .query("SELECT CONTEXT_INFO() AS mark");
    expect(after.recordset).toEqual([{ mark: null }]);
  });
});
