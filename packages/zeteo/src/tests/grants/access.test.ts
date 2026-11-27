// @module-tag int
// @module-tag platform
import { clearTestGroups, setTestGroups } from "../support/principals.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadAccess, loadAccessAs } from "../../grants/access.js";
import type { Caller } from "../../middleware/auth.js";
import { removeSources } from "../support/sources.js";
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

describe("loadAccess row rules", () => {
  const keyIds: string[] = [];
  afterAll(async () => {
    for (const u of userIds) await clearTestGroups(u);
    await removeSources(sourceIds);
    await prisma.identityValue.deleteMany({ where: { keyId: { in: keyIds } } });
    await prisma.identityKey.deleteMany({ where: { id: { in: keyIds } } });
  });

  const newKey = async () => {
    const key = await prisma.identityKey.create({
      data: {
        name: `access_${randomUUID().slice(0, 8)}`,
        label: "Key",
        createdBy: actor,
      },
    });
    keyIds.push(key.id);
    return key.id;
  };

  const ruleGrant = (
    principalType: "user" | "group",
    principalId: string,
    tableId: string,
    columnIds: string[] | "all",
    rowAccess: "all" | "rule" | "unlimited_default",
    rowRule?: Record<string, unknown>,
    identityKeyIds: string[] = []
  ) =>
    prisma.grant.create({
      data: {
        principalType,
        principalId,
        tableId,
        allColumns: columnIds === "all",
        rowAccess,
        ...(rowRule && { rowRule: rowRule as object }),
        rowRuleDescription: rowRule ? "Paid only" : null,
        identityKeyIds,
        createdBy: actor,
        ...(columnIds !== "all" && {
          columns: { create: columnIds.map((columnId) => ({ columnId })) },
        }),
      },
    });

  it("unions columns and limits rows to the rule; an all grant lifts the limit", async () => {
    const { table, columns } = await newSource("rule-union");
    const caller = newCaller();
    const groupId = randomUUID();
    await setTestGroups(caller.userId, [{ id: groupId, organizationId: null }]);
    const stored = { [columns[0].id]: { eq: "paid" } };
    const userGrant = await ruleGrant(
      "user",
      caller.userId,
      table.id,
      [columns[0].id],
      "rule",
      stored
    );
    await ruleGrant(
      "group",
      groupId,
      table.id,
      [columns[1].id, columns[2].id],
      "unlimited_default"
    );

    const access = await loadAccess(caller);
    expect(access.tableAccess(table.id)).toEqual(
      new Set(columns.map((c) => c.id))
    );
    expect(access.rowRule(table.id)).toEqual({
      kind: "filter",
      filter: stored,
      columns: new Map([
        [
          columns[0].id,
          { id: columns[0].id, name: "a", type: "text", nativeType: "text" },
        ],
      ]),
      descriptions: [{ grantId: userGrant.id, custom: "Paid only", stored }],
    });

    const otherGroup = randomUUID();
    await setTestGroups(caller.userId, [
      { id: groupId, organizationId: null },
      { id: otherGroup, organizationId: null },
    ]);
    await ruleGrant("group", otherGroup, table.id, [columns[0].id], "all");
    expect((await loadAccess(caller)).rowRule(table.id)).toBeUndefined();
  });

  it("gives no limit when no grant has a rule", async () => {
    const { table } = await newSource("rule-none");
    const caller = newCaller();
    await grant("user", caller.userId, table.id, "all");
    expect((await loadAccess(caller)).rowRule(table.id)).toBeUndefined();
  });

  it("ORs the rules of several grants, with the caller's identity values", async () => {
    const { table, columns } = await newSource("rule-or");
    const caller = newCaller();
    const groupId = randomUUID();
    await setTestGroups(caller.userId, [{ id: groupId, organizationId: null }]);
    const keyId = await newKey();
    await prisma.identityValue.createMany({
      data: ["Jane", "Joe"].map((value) => ({
        keyId,
        userId: caller.userId,
        value,
        createdBy: actor,
      })),
    });
    await ruleGrant("user", caller.userId, table.id, "all", "rule", {
      [columns[0].id]: { eq: "paid" },
    });
    await ruleGrant(
      "group",
      groupId,
      table.id,
      "all",
      "rule",
      { [columns[1].id]: { in: { identity: keyId } } },
      [keyId]
    );

    const rule = (await loadAccess(caller)).rowRule(table.id);
    expect(rule?.kind).toBe("filter");
    if (rule?.kind !== "filter") return;
    expect(rule.filter).toEqual({
      or: [
        { [columns[0].id]: { eq: "paid" } },
        { [columns[1].id]: { in: ["Jane", "Joe"] } },
      ],
    });
    expect([...rule.columns.keys()].sort()).toEqual(
      [columns[0].id, columns[1].id].sort()
    );
    expect(rule.descriptions).toHaveLength(2);
  });

  it("matches no rows when the caller has no value under the rule's key", async () => {
    const { table, columns } = await newSource("rule-empty");
    const caller = newCaller();
    const keyId = await newKey();
    await ruleGrant(
      "user",
      caller.userId,
      table.id,
      "all",
      "rule",
      { not: { [columns[0].id]: { notIn: { identity: keyId } } } },
      [keyId]
    );
    expect((await loadAccess(caller)).rowRule(table.id)).toEqual({
      kind: "never",
    });
  });

  it("drops a grant whose rule matches nothing from the OR", async () => {
    const { table, columns } = await newSource("rule-drop");
    const caller = newCaller();
    const keyId = await newKey();
    const groupId = randomUUID();
    await setTestGroups(caller.userId, [{ id: groupId, organizationId: null }]);
    await ruleGrant(
      "user",
      caller.userId,
      table.id,
      "all",
      "rule",
      { [columns[0].id]: { in: { identity: keyId } } },
      [keyId]
    );
    const kept = await ruleGrant("group", groupId, table.id, "all", "rule", {
      [columns[1].id]: { eq: "x" },
    });
    const rule = (await loadAccess(caller)).rowRule(table.id);
    expect(rule).toMatchObject({
      kind: "filter",
      filter: { [columns[1].id]: { eq: "x" } },
      descriptions: [{ grantId: kept.id }],
    });
  });

  it("is unavailable when a rule's column has gone missing", async () => {
    const { table, columns } = await newSource("rule-missing");
    const caller = newCaller();
    await ruleGrant("user", caller.userId, table.id, "all", "rule", {
      [columns[2].id]: { eq: "x" },
    });
    await prisma.sourceColumn.update({
      where: { id: columns[2].id },
      data: { missingSince: new Date() },
    });
    expect((await loadAccess(caller)).rowRule(table.id)).toEqual({
      kind: "unavailable",
      reason: "column_missing",
    });
  });

  it("is unavailable when a rule's column no longer exists", async () => {
    const { table } = await newSource("rule-gone");
    const caller = newCaller();
    await ruleGrant("user", caller.userId, table.id, "all", "rule", {
      [randomUUID()]: { eq: "x" },
    });
    expect((await loadAccess(caller)).rowRule(table.id)).toEqual({
      kind: "unavailable",
      reason: "column_missing",
    });
  });

  it("is unavailable when the values put in exceed 50,000", async () => {
    const { table, columns } = await newSource("rule-many");
    const caller = newCaller();
    const keyId = await newKey();
    await prisma.identityValue.createMany({
      data: Array.from({ length: 50_001 }, (_, i) => ({
        keyId,
        userId: caller.userId,
        value: `v${i}`,
        createdBy: actor,
      })),
    });
    await ruleGrant(
      "user",
      caller.userId,
      table.id,
      "all",
      "rule",
      { [columns[0].id]: { in: { identity: keyId } } },
      [keyId]
    );
    expect((await loadAccess(caller)).rowRule(table.id)).toEqual({
      kind: "unavailable",
      reason: "too_many_values",
    });
  });
});

describe("loadAccessAs", () => {
  afterAll(async () => {
    for (const u of userIds) await clearTestGroups(u);
    await removeSources(sourceIds);
  });

  it("counts the user's global groups and those of the organization given, not another's", async () => {
    const { table, columns } = await newSource("as");
    const { userId } = newCaller();
    const orgA = randomUUID();
    const ofA = randomUUID();
    const global = randomUUID();
    const ofB = randomUUID();
    await setTestGroups(userId, [
      { id: ofA, organizationId: orgA },
      { id: global, organizationId: null },
      { id: ofB, organizationId: randomUUID() },
    ]);
    await grant("group", ofA, table.id, [columns[0].id]);
    await grant("group", global, table.id, [columns[1].id]);
    await grant("group", ofB, table.id, [columns[2].id]);

    const access = await loadAccessAs(userId, orgA);
    expect(access.userId).toBe(userId);
    expect([...access.groupIds].sort()).toEqual([ofA, global].sort());
    expect(access.allows(table.id, columns[0].id)).toBe(true);
    expect(access.allows(table.id, columns[1].id)).toBe(true);
    expect(access.allows(table.id, columns[2].id)).toBe(false);
  });

  it("counts only global groups for no organization", async () => {
    const { userId } = newCaller();
    const global = randomUUID();
    await setTestGroups(userId, [
      { id: global, organizationId: null },
      { id: randomUUID(), organizationId: randomUUID() },
    ]);
    expect((await loadAccessAs(userId, null)).groupIds).toEqual([global]);
  });
});
