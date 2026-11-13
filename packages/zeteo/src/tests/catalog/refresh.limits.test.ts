// @module-tag int
// @module-tag platform
import { createThrowawayDb, type ThrowawayDb } from "../support/throwawayDb.js";
import type { AzureSqlConnection } from "../../adapters/azure-sql/connect.js";
import type { PostgresConnection } from "../../adapters/postgres/connect.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { initializeTereo, stopTereo } from "../../utils/tereo.js";
import { ServiceUnavailableError } from "../../utils/errors.js";
import { sealSettings } from "../../utils/crypto/envelope.js";
import { describeEachEngine } from "../support/engines.js";
import type { SourceType } from "../../adapters/types.js";
import { refreshSource } from "../../catalog/refresh.js";
import { POOL_SIZE } from "../../sources/connect.js";
import { storedType } from "../../sources/types.js";
import { prisma } from "../../utils/db/prisma.js";
import { randomUUID } from "crypto";
import {
  closeAllSourcePools,
  isSourcePoolOpen,
  withSourceConnection,
} from "../../sources/pools.js";
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

/**
 * Checks out every connection of the source's pool, as that many running
 * queries would; resolves once all are held, with their release.
 */
const holdEveryConnection = async (
  sourceId: string,
  type: SourceType
): Promise<() => Promise<void>> => {
  let letGo!: () => void;
  const gate = new Promise<void>((resolve) => {
    letGo = resolve;
  });
  let allHeld!: () => void;
  const held = new Promise<void>((resolve) => {
    allHeld = resolve;
  });
  const holding = withSourceConnection(sourceId, async (conn) => {
    if (type === "postgres") {
      const { pool } = conn as PostgresConnection;
      const clients = await Promise.all(
        Array.from({ length: POOL_SIZE }, () => pool.connect())
      );
      allHeld();
      await gate;
      for (const client of clients) client.release();
    } else {
      const pool = (conn as AzureSqlConnection).pool as unknown as {
        acquire(requester: object): Promise<object>;
        release(connection: object): void;
      };
      const connections = await Promise.all(
        Array.from({ length: POOL_SIZE }, () => pool.acquire({}))
      );
      allHeld();
      await gate;
      for (const connection of connections) pool.release(connection);
    }
  });
  await held;
  return async () => {
    letGo();
    await holding;
  };
};

describeEachEngine(
  "refreshSource while user queries hold the pool",
  (engine) => {
    const sourceId = randomUUID();

    beforeAll(async () => {
      await initializeTereo();
      await prisma.source.create({
        data: {
          id: sourceId,
          slug: uniqueSlug("busy"),
          name: "Busy",
          type: storedType(engine.type),
          sealedSettings: sealSettings(
            engine.sourceSettings(),
            sourceId
          ) as object,
          schemas: engine.schemas,
          createdBy: randomUUID(),
        },
      });
      await refreshSource(sourceId, randomUUID());
    });
    afterAll(async () => {
      await closeAllSourcePools();
      await removeSources([sourceId]);
      await stopTereo();
    });

    it("answers busy (503), leaves the source active and keeps its pool", async () => {
      const before = await prisma.source.findUniqueOrThrow({
        where: { id: sourceId },
      });
      expect(before.status).toBe("active");
      const letGo = await holdEveryConnection(sourceId, engine.type);
      try {
        const err = await refreshSource(sourceId, randomUUID()).catch(
          (e: unknown) => e
        );
        expect(err).toBeInstanceOf(ServiceUnavailableError);
        expect(err).toMatchObject({ statusCode: 503 });
        const after = await prisma.source.findUniqueOrThrow({
          where: { id: sourceId },
        });
        expect(after.status).toBe("active");
        expect(after.lastRefreshedAt).toEqual(before.lastRefreshedAt);
        expect(isSourcePoolOpen(sourceId)).toBe(true);
      } finally {
        await letGo();
      }
      await expect(
        refreshSource(sourceId, randomUUID())
      ).resolves.toBeDefined();
    });
  }
);
