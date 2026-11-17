// @module-tag int
// @module-tag platform
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { removeSources } from "../support/sources.js";
import type { Access } from "../../grants/access.js";
import { db, prisma } from "../../utils/db/index.js";
import { randomUUID } from "crypto";
import {
  loadSourceVisibleCatalog,
  loadVisibleCatalog,
} from "../../grants/visibleCatalog.js";

const actor = randomUUID();
const slug = `visible-${randomUUID().slice(0, 8)}`;
const sourceIds: string[] = [];

const accessTo = (sourceId: string, tableId: string): Access => ({
  sourceIds: new Set([sourceId]),
  tableAccess: (t) => (t === tableId ? "all" : undefined),
  allows: (t) => t === tableId,
});

describe("loadVisibleCatalog", () => {
  afterAll(() => removeSources(sourceIds));

  it("loads a granted source, and answers null for an ungranted, archived or unknown one", async () => {
    const source = await prisma.source.create({
      data: {
        slug,
        name: "Visible",
        type: "postgres",
        sealedSettings: {},
        schemas: ["public"],
        createdBy: actor,
      },
    });
    sourceIds.push(source.id);
    const table = await prisma.sourceTable.create({
      data: {
        sourceId: source.id,
        schemaName: "public",
        name: "t",
        kind: "table",
      },
    });
    await prisma.sourceColumn.create({
      data: {
        tableId: table.id,
        name: "a",
        type: "text",
        nativeType: "text",
        nullable: false,
        position: 1,
        isPrimaryKey: false,
      },
    });
    const access = accessTo(source.id, table.id);

    const catalog = await loadVisibleCatalog(slug, access);
    expect(catalog?.tables.map((t) => t.name)).toEqual(["t"]);
    expect(catalog?.tables[0].columns.map((c) => c.name)).toEqual(["a"]);

    expect(
      await loadVisibleCatalog(slug, { ...access, sourceIds: new Set() })
    ).toBeNull();
    expect(await loadVisibleCatalog("no-such-source", access)).toBeNull();

    await prisma.source.update({
      where: { id: source.id },
      data: { archivedAt: new Date() },
    });
    expect(await loadVisibleCatalog(slug, access)).toBeNull();
  });
});

describe("loadSourceVisibleCatalog", () => {
  afterEach(() => vi.restoreAllMocks());
  afterAll(() => removeSources(sourceIds));

  const newSource = async () => {
    const source = await prisma.source.create({
      data: {
        slug: `visible-by-id-${randomUUID().slice(0, 8)}`,
        name: "Visible by id",
        type: "postgres",
        sealedSettings: {},
        schemas: ["public"],
        createdBy: actor,
      },
    });
    sourceIds.push(source.id);
    const tables = [];
    for (const name of ["t", "u"]) {
      const table = await prisma.sourceTable.create({
        data: {
          sourceId: source.id,
          schemaName: "public",
          name,
          kind: "table",
        },
      });
      await prisma.sourceColumn.create({
        data: {
          tableId: table.id,
          name: "a",
          type: "number",
          nativeType: "int4",
          nullable: false,
          position: 1,
          isPrimaryKey: true,
        },
      });
      tables.push(table);
    }
    await prisma.relation.create({
      data: {
        sourceId: source.id,
        name: "u",
        fromTableId: tables[0].id,
        fromColumns: ["a"],
        toTableId: tables[1].id,
        toColumns: ["a"],
        toMany: false,
        origin: "declared",
        createdBy: actor,
      },
    });
    return { source, tables };
  };

  const everything = (sourceId: string): Access => ({
    sourceIds: new Set([sourceId]),
    tableAccess: () => "all",
    allows: () => true,
  });

  it("loads the granted tables and relations of a source by id", async () => {
    const { source } = await newSource();
    const catalog = await loadSourceVisibleCatalog(
      source.id,
      everything(source.id)
    );
    expect(catalog.source.id).toBe(source.id);
    expect(catalog.tables.map((t) => t.name)).toEqual(["t", "u"]);
    expect(catalog.relations.map((r) => r.name)).toEqual(["u"]);
  });

  it("answers the source with nothing in it, having loaded its catalogue, when it is not granted or archived", async () => {
    const { source } = await newSource();
    const load = vi.spyOn(db.catalog, "loadSourceCatalog");

    const ungranted = await loadSourceVisibleCatalog(source.id, {
      ...everything(source.id),
      sourceIds: new Set(),
    });
    expect(ungranted.source.id).toBe(source.id);
    expect(ungranted.tables).toEqual([]);
    expect(ungranted.relations).toEqual([]);

    await prisma.source.update({
      where: { id: source.id },
      data: { archivedAt: new Date() },
    });
    const archived = await loadSourceVisibleCatalog(
      source.id,
      everything(source.id)
    );
    expect(archived.source.id).toBe(source.id);
    expect(archived.tables).toEqual([]);
    expect(archived.relations).toEqual([]);

    expect(load).toHaveBeenCalledTimes(2);
    expect(load).toHaveBeenNthCalledWith(1, source.id);
    expect(load).toHaveBeenNthCalledWith(2, source.id);
  });
});
