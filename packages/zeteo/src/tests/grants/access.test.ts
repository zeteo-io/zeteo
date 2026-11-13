// @module-tag int
// @module-tag platform
import { clearTestGroups, setTestGroups } from "../support/principals.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Caller } from "../../middleware/auth.js";
import { removeSources } from "../support/sources.js";
import { loadAccess } from "../../grants/access.js";
import { prisma } from "../../utils/db/index.js";
import { randomUUID } from "crypto";

const actor = randomUUID();
const suffix = randomUUID().slice(0, 8);
const sourceIds: string[] = [];
const userIds: string[] = [];

const newSource = async (name: string, archived = false) => {
  const source = await prisma.source.create({
    data: {
      slug: `access-${name}-${suffix}`,
      name,
      type: "postgres",
      sealedSettings: {},
      schemas: ["public"],
      createdBy: actor,
      archivedAt: archived ? new Date() : null,
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
  const columns = [];
  for (const [i, col] of ["a", "b", "c"].entries()) {
    columns.push(
      await prisma.sourceColumn.create({
        data: {
          tableId: table.id,
          name: col,
          type: "text",
          nativeType: "text",
          nullable: false,
          position: i + 1,
          isPrimaryKey: false,
        },
      })
    );
  }
  return { source, table, columns };
};

const grant = (
  principalType: "user" | "group",
  principalId: string,
  tableId: string,
  columnIds: string[] | "all"
) =>
  prisma.grant.create({
    data: {
      principalType,
      principalId,
      tableId,
      allColumns: columnIds === "all",
      createdBy: actor,
      ...(columnIds !== "all" && {
        columns: { create: columnIds.map((columnId) => ({ columnId })) },
      }),
    },
  });

const newCaller = (over: Partial<Caller> = {}): Caller => {
  const userId = randomUUID();
  userIds.push(userId);
  return {
    userId,
    organizationId: null,
    permissions: [],
    isServiceAccount: false,
    ...over,
  };
};

describe("loadAccess", () => {
  afterAll(async () => {
    for (const u of userIds) await clearTestGroups(u);
    await removeSources(sourceIds);
  });
  beforeAll(() => undefined);

  it("is the union of the user's grants and a counted group's", async () => {
    const { source, table, columns } = await newSource("union");
    const caller = newCaller();
    const groupId = randomUUID();
    await setTestGroups(caller.userId, [{ id: groupId, organizationId: null }]);
    await grant("user", caller.userId, table.id, [columns[0].id]);
    await grant("group", groupId, table.id, [columns[1].id]);

    const access = await loadAccess(caller);
    expect(access.sourceIds).toEqual(new Set([source.id]));
    expect(access.allows(table.id, columns[0].id)).toBe(true);
    expect(access.allows(table.id, columns[1].id)).toBe(true);
    expect(access.allows(table.id, columns[2].id)).toBe(false);
    expect(access.tableAccess(table.id)).toEqual(
      new Set([columns[0].id, columns[1].id])
    );
  });

  it("lets an all_columns grant win over lists", async () => {
    const { table, columns } = await newSource("all");
    const caller = newCaller();
    const groupId = randomUUID();
    await setTestGroups(caller.userId, [{ id: groupId, organizationId: null }]);
    await grant("user", caller.userId, table.id, [columns[0].id]);
    await grant("group", groupId, table.id, "all");

    const access = await loadAccess(caller);
    expect(access.tableAccess(table.id)).toBe("all");
    expect(access.allows(table.id, columns[2].id)).toBe(true);
  });

  it("does not count a group of another organization", async () => {
    const { table, columns } = await newSource("org");
    const caller = newCaller({ organizationId: randomUUID() });
    const foreign = randomUUID();
    await setTestGroups(caller.userId, [
      { id: foreign, organizationId: randomUUID() },
    ]);
    await grant("group", foreign, table.id, "all");

    const access = await loadAccess(caller);
    expect(access.sourceIds.size).toBe(0);
    expect(access.tableAccess(table.id)).toBeUndefined();
    expect(access.allows(table.id, columns[0].id)).toBe(false);
  });

  it("gives a service account only its own grants", async () => {
    const { table } = await newSource("svc");
    const caller = newCaller({ isServiceAccount: true });
    const groupId = randomUUID();
    await setTestGroups(caller.userId, [{ id: groupId, organizationId: null }]);
    await grant("group", groupId, table.id, "all");
    expect((await loadAccess(caller)).sourceIds.size).toBe(0);
  });

  it("gets nothing from an archived source", async () => {
    const { table } = await newSource("archived", true);
    const caller = newCaller();
    await grant("user", caller.userId, table.id, "all");
    const access = await loadAccess(caller);
    expect(access.sourceIds.size).toBe(0);
    expect(access.tableAccess(table.id)).toBeUndefined();
  });

  it("sees a removed grant on the next load", async () => {
    const { table, columns } = await newSource("removed");
    const caller = newCaller();
    const row = await grant("user", caller.userId, table.id, [columns[0].id]);
    expect((await loadAccess(caller)).allows(table.id, columns[0].id)).toBe(
      true
    );
    await prisma.grant.delete({ where: { id: row.id } });
    const after = await loadAccess(caller);
    expect(after.allows(table.id, columns[0].id)).toBe(false);
    expect(after.sourceIds.size).toBe(0);
  });

  it("ignores a grant that lists no columns", async () => {
    const { table } = await newSource("empty");
    const caller = newCaller();
    await grant("user", caller.userId, table.id, []);
    expect((await loadAccess(caller)).sourceIds.size).toBe(0);
  });
});
