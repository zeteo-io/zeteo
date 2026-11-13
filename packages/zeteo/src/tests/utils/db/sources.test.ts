// @module-tag int
// @module-tag platform
import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "../../../utils/db/index.js";
import { randomUUID } from "crypto";

const suffix = randomUUID().slice(0, 8);
const actor = randomUUID();
const created: string[] = [];

const newSource = async (overrides: Record<string, unknown> = {}) => {
  const source = await prisma.source.create({
    data: {
      slug: `src-${suffix}-${created.length}`,
      name: "Test source",
      type: "postgres",
      sealedSettings: {},
      schemas: ["public"],
      createdBy: actor,
      ...overrides,
    },
  });
  created.push(source.id);
  return source;
};

describe("sources and catalogue constraints", () => {
  afterAll(async () => {
    await prisma.source.deleteMany({ where: { id: { in: created } } });
  });

  it("rejects a slug that is not lowercase kebab", async () => {
    await expect(newSource({ slug: "Bad Slug" })).rejects.toThrow(
      /sources_slug_format_check/
    );
  });

  it("rejects a row cap above 50000", async () => {
    await expect(newSource({ rowCap: 50001 })).rejects.toThrow(
      /sources_row_cap_check/
    );
  });

  it.each([
    [{ queryConcurrency: 0 }, "sources_query_concurrency_check"],
    [{ queryConcurrency: 51 }, "sources_query_concurrency_check"],
    [{ exportConcurrency: 0 }, "sources_export_concurrency_check"],
    [{ exportConcurrency: 11 }, "sources_export_concurrency_check"],
  ])("rejects %o", async (limit, constraint) => {
    await expect(newSource(limit)).rejects.toThrow(constraint);
  });

  it("defaults the concurrency to 5 queries and 2 exports", async () => {
    expect(await newSource()).toMatchObject({
      queryConcurrency: 5,
      exportConcurrency: 2,
    });
  });

  it("rejects a relation whose column lists differ in length", async () => {
    const source = await newSource();
    const a = await prisma.sourceTable.create({
      data: {
        sourceId: source.id,
        schemaName: "public",
        name: "a",
        kind: "table",
      },
    });
    const b = await prisma.sourceTable.create({
      data: {
        sourceId: source.id,
        schemaName: "public",
        name: "b",
        kind: "table",
      },
    });
    await expect(
      prisma.relation.create({
        data: {
          sourceId: source.id,
          name: "a_to_b",
          fromTableId: a.id,
          fromColumns: ["x", "y"],
          toTableId: b.id,
          toColumns: ["x"],
          toMany: false,
          origin: "declared",
        },
      })
    ).rejects.toThrow(/relations_columns_match_check/);
  });

  it("rejects two tables with the same source, schema and name", async () => {
    const source = await newSource();
    const table = {
      sourceId: source.id,
      schemaName: "public",
      name: "dup",
      kind: "table" as const,
    };
    await prisma.sourceTable.create({ data: table });
    await expect(prisma.sourceTable.create({ data: table })).rejects.toThrow(
      /unique/i
    );
  });
});
