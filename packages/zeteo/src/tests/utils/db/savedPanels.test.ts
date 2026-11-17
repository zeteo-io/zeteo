// @module-tag int
// @module-tag platform
import { afterAll, describe, expect, it } from "vitest";
import { db, prisma } from "../../../utils/db/index.js";
import { randomUUID } from "crypto";

const suffix = randomUUID().slice(0, 8);
const owner = randomUUID();
const other = randomUUID();
const userId = randomUUID();
const groupId = randomUUID();
const chart = { type: "line", x: "a" };

const newPanel = (ownerId: string, name: string) =>
  db.savedPanels.create({
    ownerId,
    name,
    description: "",
    savedQueryId: null,
    chart,
    timeColumn: null,
  });

describe("saved panels repository", () => {
  afterAll(async () => {
    await prisma.savedPanel.deleteMany({
      where: { ownerId: { in: [owner, other, userId] } },
    });
  });

  it("refuses a second name for one owner that differs only in case", async () => {
    await newPanel(owner, `Trend ${suffix}`);
    await expect(newPanel(owner, `TREND ${suffix}`)).rejects.toMatchObject({
      code: "P2002",
    });
    await expect(newPanel(other, `TREND ${suffix}`)).resolves.toBeDefined();
  });

  it("lists shared saved panels by user or group, not the user's own", async () => {
    const byUser = await newPanel(owner, `by-user ${suffix}`);
    const byGroup = await newPanel(owner, `by-group ${suffix}`);
    const unshared = await newPanel(owner, `unshared ${suffix}`);
    const mine = await newPanel(userId, `mine ${suffix}`);
    await prisma.$transaction(async (tx) => {
      await db.savedPanels.replaceShares(
        tx,
        byUser.id,
        [{ type: "user", id: userId }],
        owner
      );
      await db.savedPanels.replaceShares(
        tx,
        byGroup.id,
        [{ type: "group", id: groupId }],
        owner
      );
    });
    const { rows } = await db.savedPanels.listVisibleTo({
      userId,
      groupIds: [groupId],
      scope: "shared",
      limit: 50,
    });
    const ids = rows.map((r) => r.id);
    expect(ids).toEqual(expect.arrayContaining([byUser.id, byGroup.id]));
    expect(ids).not.toContain(unshared.id);
    expect(ids).not.toContain(mine.id);
  });

  it("transfers to a new owner, keeping access for the old one", async () => {
    const p = await newPanel(owner, `transfer ${suffix}`);
    await prisma.$transaction((tx) =>
      db.savedPanels.transfer(tx, p.id, other, owner)
    );
    expect((await db.savedPanels.findById(p.id))?.ownerId).toBe(other);
    expect(await db.savedPanels.listShares(p.id)).toMatchObject([
      { principalType: "user", principalId: owner },
    ]);
  });
});
