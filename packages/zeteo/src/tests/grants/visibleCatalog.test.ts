// @module-tag int
// @module-tag platform
import { loadVisibleCatalog } from "../../grants/visibleCatalog.js";
import { afterAll, describe, expect, it } from "vitest";
import { removeSources } from "../support/sources.js";
import type { Access } from "../../grants/access.js";
import { prisma } from "../../utils/db/index.js";
import { randomUUID } from "crypto";

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
