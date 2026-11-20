import { DEFAULT_CALENDAR, type Calendar } from "../../calendar/calendar.js";
import { removeSources, sourceSettings, uniqueSlug } from "./sources.js";
import { buildVisibleCatalog } from "../../grants/visibleCatalog.js";
import type { VisibleCatalog } from "../../grants/visibleCatalog.js";
import { postgresAdapter } from "../../adapters/postgres/index.js";
import { initializeTereo, stopTereo } from "../../utils/tereo.js";
import { sqlQuerySchema } from "../../adapters/sql/language.js";
import type { SourceConnection } from "../../adapters/types.js";
import { fixtureSettings, fixtureTarget } from "./fixtureDb.js";
import { sealSettings } from "../../utils/crypto/envelope.js";
import { closeAllSourcePools } from "../../sources/pools.js";
import { refreshSource } from "../../catalog/refresh.js";
import { runPlan, type TestLimits } from "./runPlan.js";
import { planSql } from "../../adapters/sql/plan.js";
import { prisma } from "../../utils/db/prisma.js";
import { afterAll, beforeAll } from "vitest";
import { db } from "../../utils/db/index.js";
import { randomUUID } from "crypto";

// What the Postgres runQuery aspect files share: a source over the fixture's
// `sales` and `probe` schemas with everything visible, and a connection to it
// as the read-only login.

const LIMITS: TestLimits = {
  maxRows: 1000,
  maxBytes: 10 * 1024 * 1024,
  timeoutMs: 5000,
};

/** Registers the file's hooks; the source and the connection exist from `beforeAll` on. */
export const usePostgresRuns = () => {
  let connection: SourceConnection;
  let catalog: VisibleCatalog;
  const sources: string[] = [];

  beforeAll(async () => {
    await initializeTereo();
    const id = randomUUID();
    sources.push(id);
    await prisma.source.create({
      data: {
        id,
        slug: uniqueSlug("query"),
        name: "Query test",
        type: "postgres",
        sealedSettings: sealSettings(sourceSettings("ro"), id) as object,
        schemas: ["sales", "probe"],
        createdBy: randomUUID(),
      },
    });
    await refreshSource(id, randomUUID());
    const source = (await db.sources.findById(id))!;
    const { tables, columns, relations } =
      await db.catalog.loadSourceCatalog(id);
    catalog = buildVisibleCatalog(
      source,
      tables,
      columns,
      relations,
      {
        sourceIds: new Set([id]),
        allows: () => true,
        tableAccess: () => "all",
      },
      { calendar: DEFAULT_CALENDAR, measures: [] }
    );
    connection = await postgresAdapter.connect(
      fixtureSettings("ro"),
      await fixtureTarget(),
      { connectTimeoutMs: 5000, poolSize: 3, queryTimeoutMs: 5000 }
    );
  });

  afterAll(async () => {
    await connection.close();
    await closeAllSourcePools();
    await removeSources(sources);
    await stopTereo();
  });

  const runWithCalendar = (calendar: Calendar, query: object) =>
    runPlan(
      "postgres",
      connection,
      planSql(sqlQuerySchema.parse({ source: catalog.source.slug, ...query }), {
        ...catalog,
        calendar,
      }),
      LIMITS
    );

  return {
    /** A run of `query` under the fixture catalogue's own calendar. */
    run: (query: object) => runWithCalendar(DEFAULT_CALENDAR, query),
    /** A run of `query` under a catalogue whose calendar is `calendar`. */
    runWithCalendar,
  };
};
