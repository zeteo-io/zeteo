// @module-tag int
// @module-tag platform
import { createThrowawayDb, type ThrowawayDb } from "../support/throwawayDb.js";
import { closeAllSourcePools, closeSourcePool } from "../../sources/pools.js";
import { declareRelation, removeRelation } from "../../catalog/service.js";
import { postgresAdapter } from "../../adapters/postgres/index.js";
import { initializeTereo, stopTereo } from "../../utils/tereo.js";
import { SourceUnreachableError } from "../../utils/errors.js";
import { sealSettings } from "../../utils/crypto/envelope.js";
import { lockSourceCatalog } from "../../catalog/lock.js";
import { refreshSource } from "../../catalog/refresh.js";
import { updateSource } from "../../sources/service.js";
import { prisma } from "../../utils/db/prisma.js";
import { randomUUID } from "crypto";
import {
  auditRows,
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
  const dump = async () => ({
    tables: await prisma.sourceTable.findMany({
      where: { sourceId },
      orderBy: { id: "asc" },
    }),
    columns: await prisma.sourceColumn.findMany({
      where: { table: { sourceId } },
      orderBy: { id: "asc" },
    }),
    relations: await prisma.relation.findMany({
      where: { sourceId },
      orderBy: { id: "asc" },
    }),
  });

  it("adds the twelve sales tables and views, their columns and six relations", async () => {
    const summary = await refreshSource(sourceId, ACTOR);
    expect(summary).toEqual({
      tables: { added: 12, missing: 0, restored: 0 },
      columns: { added: 55, changed: 0, missing: 0, restored: 0 },
      relations: { added: 6, missing: 0, restored: 0 },
    });
    expect(await counts()).toEqual({ tables: 12, columns: 55, relations: 6 });
    expect((await tableRow("paid_orders")).kind).toBe("view");
    expect(await columnRow("orders", "total")).toMatchObject({
      type: "number",
      isPrimaryKey: false,
    });

    const orders = await tableRow("orders");
    const customers = await tableRow("customers");
    const relations = await prisma.relation.findMany({ where: { sourceId } });
    const named = (from: string, name: string) =>
      relations.find((r) => r.fromTableId === from && r.name === name);
    expect(named(orders.id, "customer")).toMatchObject({
      toTableId: customers.id,
      fromColumns: ["customer_id"],
      toColumns: ["id"],
      toMany: false,
      origin: "discovered",
      constraintName: "orders_customer_id_fkey",
    });
    expect(named(customers.id, "orders")).toMatchObject({
      toTableId: orders.id,
      fromColumns: ["id"],
      toColumns: ["customer_id"],
      toMany: true,
    });
    expect(named((await tableRow("order_lines")).id, "order")).toBeDefined();
    expect(named(orders.id, "order_lines")).toBeDefined();

    const source = await prisma.source.findUniqueOrThrow({
      where: { id: sourceId },
    });
    expect(source.status).toBe("active");
    expect(source.lastRefreshedAt).toBeInstanceOf(Date);
    const entries = await auditRows(sourceId);
    expect(entries.at(-1)?.payload).toMatchObject({
      action: "UPDATE",
      userId: ACTOR,
      metadata: { event: "zeteo.source.refreshed", ...summary },
    });
  });

  it("changes nothing on a second refresh of an unchanged database", async () => {
    await refreshSource(sourceId, ACTOR);
    const before = await dump();
    const summary = await refreshSource(sourceId, ACTOR);
    expect(summary).toEqual({
      tables: { added: 0, missing: 0, restored: 0 },
      columns: { added: 0, changed: 0, missing: 0, restored: 0 },
      relations: { added: 0, missing: 0, restored: 0 },
    });
    const after = await dump();
    expect(after.columns).toEqual(before.columns);
    expect(after.relations).toEqual(before.relations);
    expect(after.tables.map((t) => t.id)).toEqual(
      before.tables.map((t) => t.id)
    );
  });

  it("marks a dropped column missing, keeping its row and description, and clears it when it returns", async () => {
    await refreshSource(sourceId, ACTOR);
    const notes = await columnRow("orders", "notes");
    await prisma.sourceColumn.update({
      where: { id: notes.id },
      data: { description: "Free text" },
    });

    await fixture.run("ALTER TABLE sales.orders DROP COLUMN notes");
    expect((await refreshSource(sourceId, ACTOR)).columns).toMatchObject({
      missing: 1,
    });
    const gone = await columnRow("orders", "notes");
    expect(gone).toMatchObject({ id: notes.id, description: "Free text" });
    expect(gone.missingSince).toBeInstanceOf(Date);

    // The mark is kept, not renewed, while the column stays missing.
    const again = await refreshSource(sourceId, ACTOR);
    expect(again.columns.missing).toBe(0);
    expect((await columnRow("orders", "notes")).missingSince).toEqual(
      gone.missingSince
    );

    await fixture.run("ALTER TABLE sales.orders ADD COLUMN notes text");
    expect((await refreshSource(sourceId, ACTOR)).columns).toMatchObject({
      restored: 1,
      added: 0,
    });
    expect(await columnRow("orders", "notes")).toMatchObject({
      id: notes.id,
      missingSince: null,
      description: "Free text",
    });
  });

  it("marks a dropped table missing, then restores it, with the same ids and description", async () => {
    await refreshSource(sourceId, ACTOR);
    const blobs = await tableRow("blobs");
    await prisma.sourceTable.update({
      where: { id: blobs.id },
      data: { description: "Binary things" },
    });
    await fixture.run("DROP TABLE sales.blobs");
    const dropped = await refreshSource(sourceId, ACTOR);
    expect(dropped.tables.missing).toBe(1);
    expect(dropped.columns.missing).toBe(3);
    expect((await tableRow("blobs")).missingSince).toBeInstanceOf(Date);
    expect(await counts()).toMatchObject({ tables: 12, columns: 55 });

    await fixture.run(
      "CREATE TABLE sales.blobs (id integer, data bytea, tags text[]); GRANT SELECT ON sales.blobs TO zeteo_ro"
    );
    const back = await refreshSource(sourceId, ACTOR);
    expect(back.tables).toMatchObject({ restored: 1, added: 0 });
    expect(back.columns).toMatchObject({ restored: 3, added: 0 });
    expect(await tableRow("blobs")).toMatchObject({
      id: blobs.id,
      missingSince: null,
      description: "Binary things",
    });
  });

  it("keeps a discovered relation's name and id when its foreign key is dropped and re-created", async () => {
    await refreshSource(sourceId, ACTOR);
    const before = await prisma.relation.findMany({
      where: { sourceId, constraintName: "orders_customer_id_fkey" },
      orderBy: { name: "asc" },
    });
    expect(before.map((r) => r.name)).toEqual(["customer", "orders"]);

    await fixture.run(
      "ALTER TABLE sales.orders DROP CONSTRAINT orders_customer_id_fkey"
    );
    expect((await refreshSource(sourceId, ACTOR)).relations).toMatchObject({
      missing: 2,
    });
    expect(
      (
        await prisma.relation.findMany({
          where: { sourceId, constraintName: "orders_customer_id_fkey" },
        })
      ).every((r) => r.missingSince !== null)
    ).toBe(true);

    await fixture.run(
      "ALTER TABLE sales.orders ADD CONSTRAINT orders_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES sales.customers (id)"
    );
    expect((await refreshSource(sourceId, ACTOR)).relations).toMatchObject({
      restored: 2,
      added: 0,
    });
    const after = await prisma.relation.findMany({
      where: { sourceId, constraintName: "orders_customer_id_fkey" },
      orderBy: { name: "asc" },
    });
    expect(after.map((r) => [r.id, r.name, r.missingSince])).toEqual(
      before.map((r) => [r.id, r.name, null])
    );
  });

  it("names a second foreign key to the same table apart", async () => {
    await fixture.run(`
      ALTER TABLE sales.orders ADD COLUMN referrer_id integer;
      ALTER TABLE sales.orders ADD CONSTRAINT orders_referrer_fkey FOREIGN KEY (referrer_id) REFERENCES sales.customers (id);
    `);
    await refreshSource(sourceId, ACTOR);
    const customers = await tableRow("customers");
    const names = (
      await prisma.relation.findMany({
        where: { fromTableId: customers.id },
      })
    )
      .map((r) => r.name)
      .sort();
    expect(names).toEqual(["account", "orders", "orders_2"]);
  });

  it("updates a column whose type changed in place and counts it as changed", async () => {
    await refreshSource(sourceId, ACTOR);
    const status = await columnRow("orders", "status");
    expect(status.type).toBe("text");
    await fixture.run(`
      DROP VIEW sales.paid_orders;
      ALTER TABLE sales.orders ALTER COLUMN status TYPE integer USING 1;
      CREATE VIEW sales.paid_orders AS SELECT id, customer_id, total FROM sales.orders WHERE status = 1;
      GRANT SELECT ON sales.paid_orders TO zeteo_ro;
    `);
    const summary = await refreshSource(sourceId, ACTOR);
    expect(summary.columns).toMatchObject({ changed: 1, added: 0, missing: 0 });
    expect(await columnRow("orders", "status")).toMatchObject({
      id: status.id,
      type: "number",
      nativeType: "integer",
    });
  });

  it("never changes a table's description", async () => {
    await refreshSource(sourceId, ACTOR);
    const orders = await tableRow("orders");
    await prisma.sourceTable.update({
      where: { id: orders.id },
      data: { description: "Customer orders" },
    });
    await fixture.run("ALTER TABLE sales.orders ADD COLUMN channel text");
    await refreshSource(sourceId, ACTOR);
    expect(await tableRow("orders")).toMatchObject({
      id: orders.id,
      description: "Customer orders",
    });
  });

  it("leaves a declared relation alone when no foreign key matches it", async () => {
    await refreshSource(sourceId, ACTOR);
    const orders = await tableRow("orders");
    const lines = await tableRow("order_lines");
    const declared = await prisma.relation.create({
      data: {
        sourceId,
        name: "lines_by_sku",
        fromTableId: orders.id,
        fromColumns: ["id"],
        toTableId: lines.id,
        toColumns: ["order_id"],
        toMany: true,
        origin: "declared",
        createdBy: ACTOR,
      },
    });
    await fixture.run(
      "ALTER TABLE sales.order_lines DROP CONSTRAINT order_lines_order_id_fkey"
    );
    const summary = await refreshSource(sourceId, ACTOR);
    expect(summary.relations.missing).toBe(2);
    expect(
      await prisma.relation.findUniqueOrThrow({ where: { id: declared.id } })
    ).toEqual(declared);
  });

  it("names a new relation around a declared one that holds the name", async () => {
    await refreshSource(sourceId, ACTOR);
    await fixture.run(`
      ALTER TABLE sales.orders ADD COLUMN referrer_id integer;
      ALTER TABLE sales.orders ADD CONSTRAINT orders_referrer_fkey FOREIGN KEY (referrer_id) REFERENCES sales.customers (id);
    `);
    const customers = await tableRow("customers");
    const orders = await tableRow("orders");
    await prisma.relation.create({
      data: {
        sourceId,
        name: "referrer",
        fromTableId: orders.id,
        fromColumns: ["customer_id"],
        toTableId: customers.id,
        toColumns: ["id"],
        toMany: false,
        origin: "declared",
      },
    });
    await refreshSource(sourceId, ACTOR);
    const found = await prisma.relation.findMany({
      where: { fromTableId: orders.id, constraintName: "orders_referrer_fkey" },
    });
    expect(found.map((r) => r.name)).toEqual(["referrer_2"]);
  });

  const fkRelations = (constraint: string) =>
    prisma.relation.findMany({
      where: { sourceId, constraintName: constraint },
      orderBy: { name: "asc" },
    });
  const customerPair = () =>
    prisma.relation.findMany({
      where: { sourceId, name: { in: ["customer", "orders"] } },
      orderBy: { name: "asc" },
    });

  it("marks relations missing when the table they point at is no longer readable", async () => {
    await refreshSource(sourceId, ACTOR);
    await fixture.run("REVOKE SELECT ON sales.customers FROM zeteo_ro");
    const summary = await refreshSource(sourceId, ACTOR);
    expect(summary.tables.missing).toBe(1);
    // Both directions of orders–customers and of customers–accounts.
    expect(summary.relations).toMatchObject({ missing: 4, restored: 0 });
    const pair = await fkRelations("orders_customer_id_fkey");
    expect(pair).toHaveLength(2);
    expect(pair.every((r) => r.missingSince !== null)).toBe(true);

    await fixture.run("GRANT SELECT ON sales.customers TO zeteo_ro");
    expect((await refreshSource(sourceId, ACTOR)).relations).toMatchObject({
      restored: 4,
    });
    expect(
      (await fkRelations("orders_customer_id_fkey")).every(
        (r) => r.missingSince === null
      )
    ).toBe(true);
  });

  describe("a foreign key under a new constraint name", () => {
    it("keeps the relations' ids and names when the constraint is renamed", async () => {
      await refreshSource(sourceId, ACTOR);
      const before = await fkRelations("orders_customer_id_fkey");
      await fixture.run(
        "ALTER TABLE sales.orders RENAME CONSTRAINT orders_customer_id_fkey TO orders_cust_fk"
      );
      const summary = await refreshSource(sourceId, ACTOR);
      expect(summary.relations).toEqual({ added: 0, missing: 0, restored: 0 });
      const after = await fkRelations("orders_cust_fk");
      expect(after.map((r) => [r.id, r.name, r.missingSince])).toEqual(
        before.map((r) => [r.id, r.name, null])
      );
      expect(await fkRelations("orders_customer_id_fkey")).toEqual([]);
    });

    it("takes the missing relations over when it is re-created under a new name in a later refresh", async () => {
      await refreshSource(sourceId, ACTOR);
      const before = await fkRelations("orders_customer_id_fkey");
      await fixture.run(
        "ALTER TABLE sales.orders DROP CONSTRAINT orders_customer_id_fkey"
      );
      await refreshSource(sourceId, ACTOR);
      await fixture.run(
        "ALTER TABLE sales.orders ADD CONSTRAINT orders_who_fkey FOREIGN KEY (customer_id) REFERENCES sales.customers (id)"
      );
      const summary = await refreshSource(sourceId, ACTOR);
      expect(summary.relations).toEqual({ added: 0, missing: 0, restored: 2 });
      const after = await fkRelations("orders_who_fkey");
      expect(after.map((r) => [r.id, r.name, r.missingSince])).toEqual(
        before.map((r) => [r.id, r.name, null])
      );
      expect(await customerPair()).toHaveLength(2);
    });

    it("never attaches one existing relation to two foreign keys of the same shape", async () => {
      await refreshSource(sourceId, ACTOR);
      const before = await fkRelations("orders_customer_id_fkey");
      await fixture.run(`
        ALTER TABLE sales.orders DROP CONSTRAINT orders_customer_id_fkey;
        ALTER TABLE sales.orders ADD CONSTRAINT orders_a_fkey FOREIGN KEY (customer_id) REFERENCES sales.customers (id);
        ALTER TABLE sales.orders ADD CONSTRAINT orders_b_fkey FOREIGN KEY (customer_id) REFERENCES sales.customers (id);
      `);
      const summary = await refreshSource(sourceId, ACTOR);
      expect(summary.relations).toEqual({ added: 2, missing: 0, restored: 0 });
      // The first constraint name in order takes the old pair over.
      const taken = await fkRelations("orders_a_fkey");
      expect(taken.map((r) => r.id).sort()).toEqual(
        before.map((r) => r.id).sort()
      );
      const fresh = await fkRelations("orders_b_fkey");
      expect(fresh).toHaveLength(2);
      expect(fresh.map((r) => r.name).sort()).toEqual([
        "customer_2",
        "orders_2",
      ]);
      const ids = [...taken, ...fresh].map((r) => r.id);
      expect(new Set(ids).size).toBe(4);
    });
  });

  it("names relations from mixed-case identifiers within the declared-name rules", async () => {
    await fixture.run(`
      CREATE TABLE sales."Order Items" ("itemId" integer PRIMARY KEY, "CustomerRef" integer REFERENCES sales.customers (id));
      GRANT SELECT ON sales."Order Items" TO zeteo_ro;
    `);
    await refreshSource(sourceId, ACTOR);
    const names = (await prisma.relation.findMany({ where: { sourceId } })).map(
      (r) => r.name
    );
    expect(names).toContain("customer_ref");
    expect(names).toContain("order_items");
    expect(names.every((n) => /^[a-z][a-z0-9_]{0,62}$/.test(n))).toBe(true);
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
      expect(await counts()).toEqual({ tables: 12, columns: 55, relations: 6 });

      const again = await Promise.all([
        refreshSource(sourceId, ACTOR),
        refreshSource(sourceId, ACTOR),
        refreshSource(sourceId, ACTOR),
      ]);
      expect(again).toHaveLength(3);
      expect(await counts()).toEqual({ tables: 12, columns: 55, relations: 6 });
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
      expect(tables).toHaveLength(12);
      for (const table of tables) {
        expect(table.missingSince).not.toBeNull();
      }
    });
  });

  describe("when the database cannot be read", () => {
    it("sets status unreachable, throws SourceUnreachableError and changes no catalogue row", async () => {
      await refreshSource(sourceId, ACTOR);
      const before = await dump();
      const refreshedAt = (
        await prisma.source.findUniqueOrThrow({ where: { id: sourceId } })
      ).lastRefreshedAt;

      await prisma.source.update({
        where: { id: sourceId },
        data: {
          sealedSettings: sealSettings(
            sourceSettings("ro", { database: fixture.name, port: 1 }),
            sourceId
          ) as object,
        },
      });
      await closeSourcePool(sourceId);
      await expect(refreshSource(sourceId, ACTOR)).rejects.toBeInstanceOf(
        SourceUnreachableError
      );

      const source = await prisma.source.findUniqueOrThrow({
        where: { id: sourceId },
      });
      expect(source.status).toBe("unreachable");
      expect(source.lastRefreshedAt).toEqual(refreshedAt);
      expect(await dump()).toEqual(before);
    });

    it("does not overwrite a newer success with unreachable", async () => {
      await refreshSource(sourceId, ACTOR);
      await closeSourcePool(sourceId);
      let release!: () => void;
      let started!: () => void;
      const held = new Promise<void>((resolve) => (release = resolve));
      const read = new Promise<void>((resolve) => (started = resolve));
      const connect = postgresAdapter.connect.bind(postgresAdapter);
      let first = true;
      vi.spyOn(postgresAdapter, "connect").mockImplementation(
        async (...args) => {
          const conn = await connect(...args);
          const readSchema = conn.readSchema.bind(conn);
          conn.readSchema = async (schemas) => {
            if (first) {
              first = false;
              started();
              await held;
              throw new SourceUnreachableError();
            }
            return readSchema(schemas);
          };
          return conn;
        }
      );
      const failing = refreshSource(sourceId, ACTOR);
      const rejected = expect(failing).rejects.toBeInstanceOf(
        SourceUnreachableError
      );
      await read;
      await refreshSource(sourceId, ACTOR);
      release();
      await rejected;
      expect(
        (await prisma.source.findUniqueOrThrow({ where: { id: sourceId } }))
          .status
      ).toBe("active");
    });

    it("sets the source active again on a successful refresh", async () => {
      await prisma.source.update({
        where: { id: sourceId },
        data: { status: "unreachable" },
      });
      await refreshSource(sourceId, ACTOR);
      expect(
        (await prisma.source.findUniqueOrThrow({ where: { id: sourceId } }))
          .status
      ).toBe("active");
    });
  });

  it("refuses an archived source and an unknown one", async () => {
    await prisma.source.update({
      where: { id: sourceId },
      data: { archivedAt: new Date() },
    });
    await expect(refreshSource(sourceId, ACTOR)).rejects.toMatchObject({
      code: "source_archived",
    });
    await expect(refreshSource(randomUUID(), ACTOR)).rejects.toMatchObject({
      code: "not_found",
    });
  });
});
