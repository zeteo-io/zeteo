// @module-tag int
// @module-tag platform
// @module-tag slow
import { postgresDialect } from "../../adapters/sql/dialects/postgres.js";
import { fixtureSettings, fixtureTarget } from "../support/fixtureDb.js";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import type { VisibleCatalog } from "../../grants/visibleCatalog.js";
import { loadVisibleCatalog } from "../../grants/visibleCatalog.js";
import { mssqlDialect } from "../../adapters/sql/dialects/mssql.js";
import { initializeTereo, stopTereo } from "../../utils/tereo.js";
import { DATA_READ } from "../../definitions/tereoDeclaration.js";
import { closeAllSourcePools } from "../../sources/pools.js";
import { describeEachEngine } from "../support/engines.js";
import { QueryTimeoutError } from "../../utils/errors.js";
import { USER_CONCURRENCY } from "../../engine/limits.js";
import type { Caller } from "../../middleware/auth.js";
import { removeSources } from "../support/sources.js";
import { acquireLease } from "../../engine/leases.js";
import { adapterFor } from "../../adapters/index.js";
import { loadAccess } from "../../grants/access.js";
import { QueryError } from "../../engine/errors.js";
import { runQuery } from "../../engine/index.js";
import { performance } from "node:perf_hooks";
import { Connection as Tds } from "tedious";
import { Client } from "pg";
import {
  mssqlFixtureSettings,
  mssqlFixtureTarget,
} from "../support/mssqlFixture.js";
import type {
  RunLimits,
  SourceConnection,
  SourceType,
} from "../../adapters/types.js";
import {
  grantTo,
  newQueryUser,
  removeRunsOf,
  seedQuerySource,
  type SeededSource,
} from "../support/queries.js";

const FIXTURES: Record<
  SourceType,
  { settings: () => unknown; target: typeof fixtureTarget }
> = {
  postgres: { settings: () => fixtureSettings("ro"), target: fixtureTarget },
  "azure-sql": {
    settings: () => mssqlFixtureSettings("ro"),
    target: mssqlFixtureTarget,
  },
};

const MAX_PARAMETERS: Record<SourceType, number> = {
  postgres: postgresDialect.maxParameters,
  "azure-sql": mssqlDialect.maxParameters,
};

const failureOf = async (promise: Promise<unknown>): Promise<Error> => {
  try {
    await promise;
  } catch (err) {
    return err as Error;
  }
  throw new Error("the query succeeded");
};

/** The run's limits, its deadline `timeoutMs` from now. */
const limitsOf = (timeoutMs: number): RunLimits => ({
  maxRows: 1000,
  maxBytes: 10 * 1024 * 1024,
  timeoutMs,
  deadlineAt: performance.now() + timeoutMs,
});

describeEachEngine(
  "runQuery: prepared before leases, one deadline",
  (engine) => {
    const adapter = adapterFor(engine.type);
    const user = newQueryUser();
    const caller: Caller = {
      userId: user.id,
      organizationId: null,
      permissions: [DATA_READ],
      isServiceAccount: false,
    };
    let source: SeededSource;
    let catalog: VisibleCatalog;
    const opened: SourceConnection[] = [];

    /** Statement texts this engine's driver puts on the wire from now on. */
    const watchWire = (): (() => string[]) => {
      if (engine.type === "postgres") {
        const query = vi.spyOn(Client.prototype, "query");
        return () =>
          query.mock.calls.map(([arg]) =>
            typeof arg === "string"
              ? arg
              : String((arg as { text?: unknown }).text)
          );
      }
      const exec = vi.spyOn(Tds.prototype, "execSql");
      return () =>
        exec.mock.calls.map(([req]) => String(req.sqlTextOrProcedure));
    };

    const connectSingle = async () => {
      const fixture = FIXTURES[engine.type];
      const conn = await adapter.connect(
        fixture.settings(),
        await fixture.target(),
        { connectTimeoutMs: 5000, poolSize: 1, queryTimeoutMs: 5000 }
      );
      opened.push(conn);
      return conn;
    };

    const prepare = (query: object) => {
      const plan = adapter.language.plan(
        adapter.language.schema.parse({ source: source.slug, ...query }),
        catalog
      );
      return adapter.prepare(plan, { limit: 1001, offset: plan.offset });
    };

    const whileSlowRuns = async () => {
      for (let i = 0; i < 100; i++) {
        if ((await engine.runningOn("slow_orders")) > 0) return;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw new Error("the slow query never started");
    };

    beforeAll(async () => {
      await initializeTereo();
      source = await seedQuerySource(engine);
      for (const table of ["orders", "slow_orders", "accounts"]) {
        await grantTo(user.principal, source.tables[table]!, "all");
      }
      catalog = (await loadVisibleCatalog(
        source.slug,
        await loadAccess(caller)
      ))!;
    });
    afterEach(() => {
      vi.restoreAllMocks();
    });
    afterAll(async () => {
      await Promise.all(opened.map((c) => c.close()));
      await closeAllSourcePools();
      await removeRunsOf([user.id]);
      await removeSources([source.id]);
      await stopTereo();
    });

    it("refuses a query over the parameter limit with too_many_parameters while both of the user's slots are held", async () => {
      const held = [];
      for (let i = 0; i < USER_CONCURRENCY; i++) {
        held.push(
          (await acquireLease(`user:${user.id}`, USER_CONCURRENCY, 60_000))!
        );
      }
      try {
        const values = MAX_PARAMETERS[engine.type] + 1;
        const lists = Array.from(
          { length: Math.ceil(values / 1000) },
          (_, j) => ({
            id: {
              in: Array.from(
                { length: Math.min(1000, values - j * 1000) },
                (_, i) => j * 1000 + i
              ),
            },
          })
        );
        const err = await failureOf(
          runQuery({
            caller,
            entryPoint: "api",
            body: {
              source: source.slug,
              from: "orders",
              select: ["id"],
              where: { or: lists },
            },
          })
        );
        expect(err).toBeInstanceOf(QueryError);
        expect(err).toMatchObject({
          statusCode: 422,
          code: "too_many_parameters",
        });
      } finally {
        await Promise.all(held.map((release) => release()));
      }
    });

    it("rejects with query_timeout, sending nothing, when the deadline passes while it waits for a connection", async () => {
      const single = await connectSingle();
      const holder = failureOf(
        single.runQuery(
          prepare({ from: "slow_orders", select: ["id"] }),
          limitsOf(1500)
        )
      );
      await whileSlowRuns();
      const wire = watchWire();
      const err = await failureOf(
        single.runQuery(
          prepare({ from: "accounts", select: ["id"] }),
          limitsOf(300)
        )
      );
      expect(err).toBeInstanceOf(QueryTimeoutError);
      expect(wire().filter((text) => /accounts|BEGIN/i.test(text))).toEqual([]);
      expect(await holder).toBeInstanceOf(QueryTimeoutError);
    });

    it("gives a statement that waited for a connection only the time left to its deadline", async () => {
      const single = await connectSingle();
      const holder = failureOf(
        single.runQuery(
          prepare({ from: "slow_orders", select: ["id"] }),
          limitsOf(2000)
        )
      );
      await whileSlowRuns();
      const begun = performance.now();
      const err = await failureOf(
        single.runQuery(
          prepare({ from: "slow_orders", select: ["id"] }),
          limitsOf(2800)
        )
      );
      const took = performance.now() - begun;
      expect(err).toBeInstanceOf(QueryTimeoutError);
      expect(took).toBeGreaterThan(2800 - 500);
      expect(took).toBeLessThan(2800 + 500);
      expect(await holder).toBeInstanceOf(QueryTimeoutError);
    });
  }
);
