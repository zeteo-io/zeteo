// @module-tag int
// @module-tag platform
import { AzureSqlConnection } from "../../../adapters/azure-sql/connect.js";
import { buildVisibleCatalog } from "../../../grants/visibleCatalog.js";
import type { VisibleCatalog } from "../../../grants/visibleCatalog.js";
import { azureSqlAdapter } from "../../../adapters/azure-sql/index.js";
import { initializeTereo, stopTereo } from "../../../utils/tereo.js";
import { removeSources, uniqueSlug } from "../../support/sources.js";
import { sqlQuerySchema } from "../../../adapters/sql/language.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_CALENDAR } from "../../../calendar/calendar.js";
import { sealSettings } from "../../../utils/crypto/envelope.js";
import { closeAllSourcePools } from "../../../sources/pools.js";
import type { RowRule } from "../../../row-rules/resolve.js";
import { refreshSource } from "../../../catalog/refresh.js";
import { planSql } from "../../../adapters/sql/plan.js";
import { prisma } from "../../../utils/db/prisma.js";
import { runPlan } from "../../support/runPlan.js";
import { db } from "../../../utils/db/index.js";
import { randomUUID } from "node:crypto";
import {
  mssqlFixtureSettings,
  mssqlFixtureTarget,
  mssqlSourceSettings,
} from "../../support/mssqlFixture.js";
import {
  LIMITS,
  OPTIONS,
  failureOf,
  limitsOf,
  runningOn,
  waitFor,
} from "../../support/mssqlRuns.js";

// A ruled table is copied into a temp table of the request (`#r0`…) by a
// statement of its own before the query reads it. A request stopped while it
// copies, or while its rows are read, must leave nothing on its connection
// that the next request on that connection could read: that one stages its
// own copy, and no copy outlives its request.

describe("azure-sql runQuery: a stopped ruled query leaves nothing behind", () => {
  const sourceId = randomUUID();
  let catalog: VisibleCatalog;
  let single: AzureSqlConnection;

  beforeAll(async () => {
    await initializeTereo();
    await prisma.source.create({
      data: {
        id: sourceId,
        slug: uniqueSlug("rrstop"),
        name: "Stopped ruled queries",
        type: "azure_sql",
        sealedSettings: sealSettings(
          mssqlSourceSettings("ro"),
          sourceId
        ) as object,
        schemas: ["sales", "probe"],
        createdBy: randomUUID(),
      },
    });
    await refreshSource(sourceId, randomUUID());
    const source = (await db.sources.findById(sourceId))!;
    const { tables, columns, relations } =
      await db.catalog.loadSourceCatalog(sourceId);
    const rules = new Map<string, RowRule>();
    for (const [table, column, filter] of [
      ["trickle", "id", { gt: 0 }],
      ["wide_rows", "id", { lte: 3000 }],
      ["accounts", "plan", { eq: "starter" }],
    ] as const) {
      const t = tables.find((x) => x.name === table)!;
      const c = columns.find((x) => x.tableId === t.id && x.name === column)!;
      rules.set(t.id, {
        kind: "filter",
        filter: { [c.id]: filter },
        columns: new Map([
          [
            c.id,
            {
              id: c.id,
              name: c.name,
              type: c.type as "number",
              nativeType: c.nativeType,
            },
          ],
        ]),
        descriptions: [],
      } as RowRule);
    }
    catalog = buildVisibleCatalog(
      source,
      tables,
      columns,
      relations,
      {
        sourceIds: new Set([sourceId]),
        allows: () => true,
        tableAccess: () => "all",
        rowRule: (tableId: string) => rules.get(tableId),
      },
      { calendar: DEFAULT_CALENDAR, measures: [] }
    );
    single = (await azureSqlAdapter.connect(
      mssqlFixtureSettings("ro"),
      await mssqlFixtureTarget(),
      { ...OPTIONS, poolSize: 1 }
    )) as AzureSqlConnection;
  });
  afterAll(async () => {
    await single?.close();
    await closeAllSourcePools();
    await removeSources([sourceId]);
    await stopTereo();
  });

  const plan = (query: object) =>
    planSql(
      sqlQuerySchema.parse({ source: catalog.source.slug, ...query }),
      catalog
    );

  /** The connection's session, and whether a `#r0` is left on it. */
  const session = async () =>
    (
      await single.pool
        .request()
        .query(
          "SELECT @@SPID AS spid, @@TRANCOUNT AS open_transactions, CASE WHEN OBJECT_ID('tempdb..#r0') IS NULL THEN 0 ELSE 1 END AS staged"
        )
    ).recordset[0] as {
      spid: number;
      open_transactions: number;
      staged: number;
    };

  /** The next ruled query on the same connection reads only its own rule's rows. */
  const nextIsClean = async () => {
    const accounts = await runPlan(
      "azure-sql",
      single,
      plan({ from: "accounts", select: ["id", "name"] }),
      LIMITS
    );
    expect(accounts.rows).toEqual([[2, "Contoso"]]);
  };

  it("stopped while it copies the rule's rows", async () => {
    const before = await session();
    const controller = new AbortController();
    const running = failureOf(
      runPlan(
        "azure-sql",
        single,
        // The filler is what is slow to read: the copy takes it.
        plan({ from: "trickle", select: ["id", "filler"] }),
        { ...LIMITS, timeoutMs: 30_000 },
        controller.signal
      )
    );
    await waitFor(() => runningOn("#r0"));
    controller.abort(new Error("client went away"));
    expect((await running).message).toBe("client went away");
    expect(await session()).toEqual({ ...before, staged: 0 });
    await nextIsClean();
  });

  it("stopped while its rows are read", async () => {
    const before = await session();
    const controller = new AbortController();
    const stream = await single.openQuery(
      azureSqlAdapter.prepare(
        plan({ from: "wide_rows", select: ["id", "filler"] }),
        { limit: 1_000_000, offset: 0 }
      ),
      limitsOf(10_000),
      controller.signal
    );
    expect((await stream.next(10)).length).toBeGreaterThan(0);
    controller.abort(new Error("client went away"));
    await stream.close();
    const after = await session();
    // The connection may be the same session or a new one, never one with a
    // copy left on it.
    expect(after.staged).toBe(0);
    expect(after.open_transactions).toBe(0);
    if (after.spid !== before.spid) {
      console.info("the stopped request's connection was replaced");
    }
    await nextIsClean();
  });

  it("stopped at its deadline while it copies", async () => {
    const err = await failureOf(
      runPlan(
        "azure-sql",
        single,
        // The filler is what is slow to read: the copy takes it.
        plan({ from: "trickle", select: ["id", "filler"] }),
        { ...LIMITS, timeoutMs: 500 }
      )
    );
    expect(err.name).toBe("QueryTimeoutError");
    expect((await session()).staged).toBe(0);
    await nextIsClean();
  });
});
