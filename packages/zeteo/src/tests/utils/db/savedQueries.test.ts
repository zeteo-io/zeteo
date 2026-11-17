// @module-tag int
// @module-tag platform
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { removeSources } from "../../support/sources.js";
import { db, prisma } from "../../../utils/db/index.js";
import { randomUUID } from "crypto";

const suffix = randomUUID().slice(0, 8);
const owner = randomUUID();
const other = randomUUID();
const userId = randomUUID();
const groupId = randomUUID();
const sourceIds: string[] = [];
let sourceId: string;

const query = { source: "x", from: "t", select: ["a"] };

const newQuery = (ownerId: string, name: string) =>
  db.savedQueries.create({
    ownerId,
    sourceId,
    name,
    description: "",
    query,
  });

describe("saved queries repository", () => {
  beforeAll(async () => {
    const source = await prisma.source.create({
      data: {
        slug: `sq-${suffix}`,
        name: "Saved queries",
        type: "postgres",
        sealedSettings: {},
        schemas: [],
        createdBy: owner,
      },
    });
    sourceId = source.id;
    sourceIds.push(source.id);
  });

  afterAll(async () => {
    await prisma.savedQuery.deleteMany({ where: { sourceId } });
    await prisma.queryRun.deleteMany({ where: { sourceId } });
    await removeSources(sourceIds);
  });

  it("refuses a second name for one owner that differs only in case", async () => {
    await newQuery(owner, `Revenue ${suffix}`);
    await expect(newQuery(owner, `REVENUE ${suffix}`)).rejects.toMatchObject({
      code: "P2002",
    });
    await expect(newQuery(other, `REVENUE ${suffix}`)).resolves.toBeDefined();
  });

  it("lists shared queries by user or group, never the user's own", async () => {
    const byUser = await newQuery(owner, `by-user ${suffix}`);
    const byGroup = await newQuery(owner, `by-group ${suffix}`);
    const unshared = await newQuery(owner, `unshared ${suffix}`);
    const owned = await newQuery(userId, `owned ${suffix}`);
    await prisma.$transaction(async (tx) => {
      await db.savedQueries.replaceShares(
        tx,
        byUser.id,
        [{ type: "user", id: userId }],
        owner
      );
      await db.savedQueries.replaceShares(
        tx,
        byGroup.id,
        [{ type: "group", id: groupId }],
        owner
      );
      await db.savedQueries.replaceShares(
        tx,
        owned.id,
        [{ type: "user", id: userId }],
        owner
      );
    });
    const { rows } = await db.savedQueries.listVisibleTo({
      userId,
      groupIds: [groupId],
      scope: "shared",
      q: suffix,
      limit: 50,
    });
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(byUser.id);
    expect(ids).toContain(byGroup.id);
    expect(ids).not.toContain(owned.id);
    expect(ids).not.toContain(unshared.id);
    expect(rows.every((r) => r.sharedAt instanceof Date)).toBe(true);

    const mine = await db.savedQueries.listVisibleTo({
      userId,
      groupIds: [groupId],
      scope: "mine",
      q: suffix,
      limit: 50,
    });
    expect(mine.rows.map((r) => r.id)).toEqual([owned.id]);

    const withoutGroup = await db.savedQueries.listVisibleTo({
      userId,
      groupIds: [],
      scope: "shared",
      q: suffix,
      limit: 50,
    });
    expect(withoutGroup.rows.map((r) => r.id)).not.toContain(byGroup.id);
  });

  it("replaceShares reports what it added and removed", async () => {
    const sq = await newQuery(owner, `diff ${suffix}`);
    const a = { type: "user" as const, id: randomUUID() };
    const b = { type: "group" as const, id: randomUUID() };
    const first = await prisma.$transaction((tx) =>
      db.savedQueries.replaceShares(tx, sq.id, [a, b], owner)
    );
    expect(first.added).toHaveLength(2);
    expect(first.removed).toHaveLength(0);
    const second = await prisma.$transaction((tx) =>
      db.savedQueries.replaceShares(tx, sq.id, [b], owner)
    );
    expect(second).toEqual({ added: [], removed: [a] });
    expect(await db.savedQueries.listShares(sq.id)).toHaveLength(1);
  });

  it("transfer changes the owner and can keep the old owner's access", async () => {
    const sq = await newQuery(owner, `transfer ${suffix}`);
    await prisma.$transaction((tx) =>
      db.savedQueries.transfer(tx, sq.id, other, owner)
    );
    expect((await db.savedQueries.findById(sq.id))?.ownerId).toBe(other);
    expect(await db.savedQueries.listShares(sq.id)).toMatchObject([
      { principalType: "user", principalId: owner },
    ]);
  });

  it("stampRun sets the saved query's and the user's last run", async () => {
    const sq = await newQuery(owner, `stamp ${suffix}`);
    const at = new Date("2026-11-17T10:00:00.000Z");
    await db.savedQueries.stampRun(sq.id, userId, at);
    expect((await db.savedQueries.findById(sq.id))?.lastRunAt).toEqual(at);
    const run = await prisma.savedQueryUserRun.findUnique({
      where: { savedQueryId_userId: { savedQueryId: sq.id, userId } },
    });
    expect(run?.lastRunAt).toEqual(at);
    const later = new Date("2026-11-17T11:00:00.000Z");
    await db.savedQueries.stampRun(sq.id, userId, later);
    const { rows } = await db.savedQueries.listVisibleTo({
      userId: owner,
      groupIds: [],
      scope: "mine",
      q: `stamp ${suffix}`,
      limit: 5,
    });
    expect(rows[0].userLastRunAt).toBeNull();
    expect(rows[0].lastRunAt).toEqual(later);
  });

  it("deleting a saved query nulls its runs' link and removes its shares and user runs", async () => {
    const sq = await newQuery(owner, `delete ${suffix}`);
    await prisma.$transaction((tx) =>
      db.savedQueries.replaceShares(
        tx,
        sq.id,
        [{ type: "user", id: userId }],
        owner
      )
    );
    await db.savedQueries.stampRun(sq.id, userId, new Date());
    const run = await prisma.queryRun.create({
      data: {
        userId,
        sourceId,
        entryPoint: "api",
        query,
        durationMs: 1,
        outcome: "ok",
        savedQueryId: sq.id,
      },
    });
    await db.savedQueries.remove(sq.id);
    expect(
      (await prisma.queryRun.findUnique({ where: { id: run.id } }))
        ?.savedQueryId
    ).toBeNull();
    expect(
      await prisma.savedQueryShare.count({ where: { savedQueryId: sq.id } })
    ).toBe(0);
    expect(
      await prisma.savedQueryUserRun.count({ where: { savedQueryId: sq.id } })
    ).toBe(0);
  });

  it("refuses to delete a source that has saved queries", async () => {
    await expect(
      prisma.source.delete({ where: { id: sourceId } })
    ).rejects.toMatchObject({ code: "P2003" });
  });
});
