// @module-tag int
// @module-tag platform
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { removeSources } from "../../support/sources.js";
import { db, prisma } from "../../../utils/db/index.js";
import { randomUUID } from "crypto";

const suffix = randomUUID().slice(0, 8);
const actor = randomUUID();
const userId = randomUUID();
const groupId = randomUUID();
const sourceIds: string[] = [];

let tableA: { id: string };
let tableB: { id: string };
let columnA: { id: string };
let columnB: { id: string };
let sourceId: string;

const newGrant = (
  principalType: "user" | "group",
  principalId: string,
  tableId: string,
  extra: Record<string, unknown> = {}
) =>
  prisma.grant.create({
    data: {
      principalType,
      principalId,
      tableId,
      allColumns: false,
      createdBy: actor,
      ...extra,
    },
  });

describe("grants and query runs", () => {
  beforeAll(async () => {
    const source = await prisma.source.create({
      data: {
        slug: `grants-${suffix}`,
        name: "Grants test",
        type: "postgres",
        sealedSettings: {},
        schemas: ["public"],
        createdBy: actor,
      },
    });
    sourceId = source.id;
    sourceIds.push(source.id);
    const table = (name: string) =>
      prisma.sourceTable.create({
        data: { sourceId, schemaName: "public", name, kind: "table" },
      });
    tableA = await table("a");
    tableB = await table("b");
    const column = (tableId: string, name: string) =>
      prisma.sourceColumn.create({
        data: {
          tableId,
          name,
          type: "text",
          nativeType: "text",
          nullable: false,
          position: 1,
          isPrimaryKey: false,
        },
      });
    columnA = await column(tableA.id, "x");
    columnB = await column(tableB.id, "y");
  });

  afterAll(async () => {
    await prisma.queryRun.deleteMany({ where: { sourceId } });
    await prisma.grant.deleteMany({
      where: { tableId: { in: [tableA.id, tableB.id] } },
    });
    await removeSources(sourceIds);
  });

  it("refuses to delete a table that has a grant", async () => {
    const tableC = await prisma.sourceTable.create({
      data: { sourceId, schemaName: "public", name: "c", kind: "table" },
    });
    await newGrant("user", randomUUID(), tableC.id);
    await expect(
      prisma.sourceTable.delete({ where: { id: tableC.id } })
    ).rejects.toThrow(/foreign key/i);
    await prisma.grant.deleteMany({ where: { tableId: tableC.id } });
    await prisma.sourceTable.delete({ where: { id: tableC.id } });
  });

  it("refuses to delete a column that a grant lists", async () => {
    const grant = await newGrant("user", randomUUID(), tableB.id, {
      columns: { create: [{ columnId: columnB.id }] },
    });
    await expect(
      prisma.sourceColumn.delete({ where: { id: columnB.id } })
    ).rejects.toThrow(/foreign key/i);
    await prisma.grant.delete({ where: { id: grant.id } });
  });

  it("refuses a second grant for the same principal and table", async () => {
    const principal = randomUUID();
    await newGrant("user", principal, tableA.id);
    await expect(newGrant("user", principal, tableA.id)).rejects.toThrow(
      /unique/i
    );
    // The same id as a group is a different principal.
    await newGrant("group", principal, tableA.id);
  });

  it("refuses a row filter: the column is reserved", async () => {
    await expect(
      newGrant("user", randomUUID(), tableA.id, { rowFilter: { a: 1 } })
    ).rejects.toThrow(/grants_row_filter_reserved_check/);
  });

  it("lists a user's and a group's grants together with column ids and the source", async () => {
    await newGrant("user", userId, tableA.id, {
      columns: { create: [{ columnId: columnA.id }] },
    });
    await newGrant("group", groupId, tableB.id, { allColumns: true });
    const found = await db.grants.listForPrincipals([
      { type: "user", id: userId },
      { type: "group", id: groupId },
    ]);
    expect(found).toHaveLength(2);
    const user = found.find((g) => g.principalType === "user")!;
    expect(user.columns.map((c) => c.columnId)).toEqual([columnA.id]);
    expect(user.table.sourceId).toBe(sourceId);
    const group = found.find((g) => g.principalType === "group")!;
    expect(group.allColumns).toBe(true);
    expect(group.columns).toEqual([]);
    expect(await db.grants.listForPrincipals([])).toEqual([]);
  });

  it("pages grants by filter", async () => {
    const page1 = await db.grants.listPage({ sourceId, limit: 2 });
    expect(page1.rows).toHaveLength(2);
    expect(page1.hasMore).toBe(true);
    const page2 = await db.grants.listPage({
      sourceId,
      limit: 2,
      cursor: page1.rows[1]!.id,
    });
    expect(page2.rows.every((r) => r.id > page1.rows[1]!.id)).toBe(true);
    const one = await db.grants.listPage({
      principalType: "user",
      principalId: userId,
      tableId: tableA.id,
      limit: 10,
    });
    expect(one.rows).toHaveLength(1);
    expect(one.hasMore).toBe(false);
    expect((await db.grants.findById(one.rows[0]!.id))?.principalId).toBe(
      userId
    );
    expect(await db.grants.findById(randomUUID())).toBeNull();
  });

  it("records and pages query runs", async () => {
    const run = (outcome: "ok" | "refused", user = userId) =>
      prisma.queryRun.create({
        data: {
          userId: user,
          sourceId,
          entryPoint: "api",
          query: { from: "a" },
          durationMs: 3,
          rowCount: outcome === "ok" ? 1 : null,
          outcome,
        },
      });
    const older = await run("ok");
    const newer = await run("refused");
    await run("ok", randomUUID());
    const mine = await db.queryRuns.listPage({ userId, limit: 10 });
    // Newest first.
    expect(mine.rows.map((r) => r.id)).toEqual([newer.id, older.id]);
    const refused = await db.queryRuns.listPage({
      sourceId,
      outcome: "refused",
      limit: 10,
    });
    expect(refused.rows).toHaveLength(1);
    const first = await db.queryRuns.listPage({ sourceId, limit: 1 });
    expect(first.hasMore).toBe(true);
    const next = await db.queryRuns.listPage({
      sourceId,
      limit: 5,
      cursor: first.rows[0]!.id,
    });
    expect(next.rows.map((r) => r.id)).toEqual([newer.id, older.id]);
    expect(mine.rows[0]!.truncated).toBe(false);
  });
});
