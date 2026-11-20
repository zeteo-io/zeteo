// @module-tag int
// @module-tag platform
import { createThrowawayDb, type ThrowawayDb } from "../support/throwawayDb.js";
import { closeAllSourcePools, closeSourcePool } from "../../sources/pools.js";
import { declareRelation, removeRelation } from "../../catalog/service.js";
import { postgresAdapter } from "../../adapters/postgres/index.js";
import { initializeTereo, stopTereo } from "../../utils/tereo.js";
import { sealSettings } from "../../utils/crypto/envelope.js";
import { lockSourceCatalog } from "../../catalog/lock.js";
import { refreshSource } from "../../catalog/refresh.js";
import { updateSource } from "../../sources/service.js";
import { prisma } from "../../utils/db/prisma.js";
import { randomUUID } from "crypto";
import {
  removeSources,
  sourceSettings,
  uniqueSlug,
} from "../support/sources.js";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const ACTOR = randomUUID();

describe("refreshSource", () => {
  const sources: string[] = [];
  let fixture: ThrowawayDb;
  let sourceId: string;

  beforeAll(async () => {
    await initializeTereo();
  });
  afterAll(async () => {
    await removeSources(sources);
    await stopTereo();
  });
  beforeEach(async () => {
    fixture = await createThrowawayDb();
    sourceId = randomUUID();
    sources.push(sourceId);
    await prisma.source.create({
      data: {
        id: sourceId,
        slug: uniqueSlug("refresh"),
        name: "Refresh test",
        type: "postgres",
        sealedSettings: sealSettings(
          sourceSettings("ro", { database: fixture.name }),
          sourceId
        ) as object,
        schemas: ["sales"],
        createdBy: randomUUID(),
      },
    });
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await closeAllSourcePools();
    await fixture.drop();
  });

  const tableRow = (name: string) =>
    prisma.sourceTable.findFirstOrThrow({ where: { sourceId, name } });
  const columnRow = async (table: string, name: string) =>
    prisma.sourceColumn.findFirstOrThrow({
      where: { name, table: { sourceId, name: table } },
    });
  const counts = async () => ({
    tables: await prisma.sourceTable.count({ where: { sourceId } }),
    columns: await prisma.sourceColumn.count({
      where: { table: { sourceId } },
    }),
    relations: await prisma.relation.count({ where: { sourceId } }),
  });

  describe("declaring and removing relations while a refresh holds the lock", () => {
    const holdLock = async () => {
      let release!: () => void;
      let locked!: () => void;
      const held = new Promise<void>((resolve) => (release = resolve));
      const ready = new Promise<void>((resolve) => (locked = resolve));
      const holder = prisma.$transaction(async (tx) => {
        await lockSourceCatalog(tx, sourceId);
        locked();
        await held;
      });
      await ready;
      return { release, holder };
    };
    const pending = async (promise: Promise<unknown>) => {
      let done = false;
      const tracked = promise.then(() => {
        done = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 300));
      return { isDone: () => done, tracked };
    };

    it("waits for the lock before declaring", async () => {
      await refreshSource(sourceId, ACTOR);
      const orders = await tableRow("orders");
      const customers = await tableRow("customers");
      const lock = await holdLock();
      const declared = pending(
        declareRelation(
          sourceId,
          {
            name: "by_status",
            fromTableId: orders.id,
            fromColumns: ["status"],
            toTableId: customers.id,
            toColumns: ["region"],
            toMany: false,
          },
          ACTOR
        )
      );
      const waiting = await declared;
      expect(waiting.isDone()).toBe(false);
      lock.release();
      await lock.holder;
      await waiting.tracked;
      expect(waiting.isDone()).toBe(true);
    });

    it("waits for the lock before removing", async () => {
      await refreshSource(sourceId, ACTOR);
      const orders = await tableRow("orders");
      const customers = await tableRow("customers");
      const relation = await declareRelation(
        sourceId,
        {
          name: "by_status",
          fromTableId: orders.id,
          fromColumns: ["status"],
          toTableId: customers.id,
          toColumns: ["region"],
          toMany: false,
        },
        ACTOR
      );
      const lock = await holdLock();
      const waiting = await pending(
        removeRelation(sourceId, relation.id, ACTOR)
      );
      expect(waiting.isDone()).toBe(false);
      lock.release();
      await lock.holder;
      await waiting.tracked;
      expect(await prisma.relation.count({ where: { id: relation.id } })).toBe(
        0
      );
    });

    it("never fails a refresh or a declare racing for one name", async () => {
      await refreshSource(sourceId, ACTOR);
      await fixture.run(`
        ALTER TABLE sales.orders ADD COLUMN referrer_id integer;
        ALTER TABLE sales.orders ADD CONSTRAINT orders_referrer_fkey FOREIGN KEY (referrer_id) REFERENCES sales.customers (id);
      `);
      const orders = await tableRow("orders");
      const customers = await tableRow("customers");
      const [refreshed, declared] = await Promise.allSettled([
        refreshSource(sourceId, ACTOR),
        declareRelation(
          sourceId,
          {
            name: "referrer",
            fromTableId: orders.id,
            fromColumns: ["status"],
            toTableId: customers.id,
            toColumns: ["region"],
            toMany: false,
          },
          ACTOR
        ),
      ]);
      expect(refreshed.status).toBe("fulfilled");
      if (declared.status === "rejected") {
        expect(declared.reason).toMatchObject({ code: "relation_name_taken" });
      }
    });
  });

  describe("concurrency", () => {
    it("lets two refreshes started together both resolve, leaving no duplicate rows", async () => {
      const results = await Promise.all([
        refreshSource(sourceId, ACTOR),
        refreshSource(sourceId, ACTOR),
      ]);
      expect(results).toHaveLength(2);
      expect(await counts()).toEqual({ tables: 13, columns: 59, relations: 6 });

      const again = await Promise.all([
        refreshSource(sourceId, ACTOR),
        refreshSource(sourceId, ACTOR),
        refreshSource(sourceId, ACTOR),
      ]);
      expect(again).toHaveLength(3);
      expect(await counts()).toEqual({ tables: 13, columns: 59, relations: 6 });
    });

    it("ends matching the newer snapshot when an older read lands last", async () => {
      await refreshSource(sourceId, ACTOR);
      await closeSourcePool(sourceId);

      // The first read through the pool is held after it has read the old schema.
      let release!: () => void;
      let readDone!: () => void;
      const held = new Promise<void>((resolve) => (release = resolve));
      const read = new Promise<void>((resolve) => (readDone = resolve));
      const connect = postgresAdapter.connect.bind(postgresAdapter);
      let first = true;
      vi.spyOn(postgresAdapter, "connect").mockImplementation(
        async (...args) => {
          const conn = await connect(...args);
          const readSchema = conn.readSchema.bind(conn);
          conn.readSchema = async (schemas) => {
            const snapshot = await readSchema(schemas);
            if (first) {
              first = false;
              readDone();
              await held;
            }
            return snapshot;
          };
          return conn;
        }
      );

      const slow = refreshSource(sourceId, ACTOR);
      await read;
      await fixture.run("ALTER TABLE sales.customers ADD COLUMN phone text");
      await refreshSource(sourceId, ACTOR);
      release();
      await slow;

      expect((await columnRow("customers", "phone")).missingSince).toBeNull();
    });

    it("reads again when the source's schemas changed during the read", async () => {
      await refreshSource(sourceId, ACTOR);
      await closeSourcePool(sourceId);

      let release!: () => void;
      let readDone!: () => void;
      const held = new Promise<void>((resolve) => (release = resolve));
      const read = new Promise<void>((resolve) => (readDone = resolve));
      const connect = postgresAdapter.connect.bind(postgresAdapter);
      let first = true;
      vi.spyOn(postgresAdapter, "connect").mockImplementation(
        async (...args) => {
          const conn = await connect(...args);
          const readSchema = conn.readSchema.bind(conn);
          conn.readSchema = async (schemas) => {
            const snapshot = await readSchema(schemas);
            if (first) {
              first = false;
              readDone();
              await held;
            }
            return snapshot;
          };
          return conn;
        }
      );

      const slow = refreshSource(sourceId, ACTOR);
      await read;
      // The read above saw `sales`; the list no longer holds it.
      await updateSource(sourceId, { schemas: ["hr"] }, ACTOR);
      release();
      await slow;

      const tables = await prisma.sourceTable.findMany({ where: { sourceId } });
      expect(tables).toHaveLength(13);
      for (const table of tables) {
        expect(table.missingSince).not.toBeNull();
      }
    });
  });
});
