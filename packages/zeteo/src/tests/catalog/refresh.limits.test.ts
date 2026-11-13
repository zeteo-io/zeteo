// @module-tag int
// @module-tag platform
import { createThrowawayDb, type ThrowawayDb } from "../support/throwawayDb.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { initializeTereo, stopTereo } from "../../utils/tereo.js";
import { sealSettings } from "../../utils/crypto/envelope.js";
import { closeAllSourcePools } from "../../sources/pools.js";
import { refreshSource } from "../../catalog/refresh.js";
import { prisma } from "../../utils/db/prisma.js";
import { randomUUID } from "crypto";
import {
  removeSources,
  sourceSettings,
  uniqueSlug,
} from "../support/sources.js";

const TABLES = 200;
const COLUMNS = 100;

describe("refreshSource on a wide schema", () => {
  let fixture: ThrowawayDb;
  const sourceId = randomUUID();

  beforeAll(async () => {
    await initializeTereo();
    fixture = await createThrowawayDb();
    await fixture.run(`
      CREATE SCHEMA wide;
      DO $$
      BEGIN
        FOR t IN 1..${TABLES} LOOP
          EXECUTE format('CREATE TABLE wide.t%s (id integer PRIMARY KEY, %s)', t,
            (SELECT string_agg(format('c%s text', c), ', ') FROM generate_series(2, ${COLUMNS}) c));
        END LOOP;
      END $$;
      GRANT USAGE ON SCHEMA wide TO zeteo_ro;
      GRANT SELECT ON ALL TABLES IN SCHEMA wide TO zeteo_ro;
    `);
    await prisma.source.create({
      data: {
        id: sourceId,
        slug: uniqueSlug("wide"),
        name: "Wide",
        type: "postgres",
        sealedSettings: sealSettings(
          sourceSettings("ro", { database: fixture.name }),
          sourceId
        ) as object,
        schemas: ["wide"],
        createdBy: randomUUID(),
      },
    });
  });
  afterAll(async () => {
    await closeAllSourcePools();
    await removeSources([sourceId]);
    await fixture.drop();
    await stopTereo();
  });

  it(`refreshes ${TABLES} tables of ${COLUMNS} columns, then again unchanged`, async () => {
    const summary = await refreshSource(sourceId, randomUUID());
    expect(summary.tables.added).toBe(TABLES);
    expect(summary.columns.added).toBe(TABLES * COLUMNS);

    const again = await refreshSource(sourceId, randomUUID());
    expect(again.tables).toEqual({ added: 0, missing: 0, restored: 0 });
    expect(again.columns).toEqual({
      added: 0,
      changed: 0,
      missing: 0,
      restored: 0,
    });
  });
});
