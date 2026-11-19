// @module-tag int
// @module-tag platform
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { claimSpreadsheet } from "../../uploads/claims.js";
import { SheetInUseError } from "../../utils/errors.js";
import { removeSources } from "../support/sources.js";
import { prisma } from "../../utils/db/prisma.js";
import { setTimeout } from "timers/promises";
import { randomUUID } from "crypto";

// Two transactions claiming one spreadsheet, interleaved by hand: the second
// claim blocks on the first's uncommitted row, then sees how it ended.

const ownerId = randomUUID();
const sources: string[] = [];

const newSource = async () => {
  const id = randomUUID();
  await prisma.source.create({
    data: {
      id,
      slug: `claim-race-${id.slice(0, 8)}`,
      name: "Claims",
      type: "upload",
      ownerId,
      sealedSettings: {},
      schemas: [],
      createdBy: ownerId,
    },
  });
  sources.push(id);
  return id;
};

let a: string;
let b: string;
beforeAll(async () => {
  a = await newSource();
  b = await newSource();
});
afterAll(async () => {
  await prisma.uploadClaim.deleteMany({ where: { sourceId: { in: sources } } });
  await removeSources(sources);
});

/** A promise and its resolver. */
const gate = () => {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { open, opened };
};

/** Waits until a backend is waiting on a lock while inserting a claim of `sheet`'s. */
const untilBlocked = async () => {
  for (let i = 0; i < 200; i++) {
    const rows = await prisma.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE wait_event_type = 'Lock' AND query LIKE '%upload_claims%'`;
    if (rows[0]!.n > 0) return;
    await setTimeout(25);
  }
  throw new Error("the second claim never blocked");
};

/**
 * tx1 claims for `a` and holds its transaction open until told how to end;
 * tx2 claims for `b` once tx1 has, and must block until tx1 ends.
 */
const race = async (end: "commit" | "rollback") => {
  const sheet = `sheet-${randomUUID()}`;
  const claimed = gate();
  const finish = gate();
  const tx1 = prisma
    .$transaction(
      async (tx) => {
        await claimSpreadsheet(tx, a, sheet);
        claimed.open();
        await finish.opened;
        if (end === "rollback") throw new Error("rolled back");
      },
      { timeout: 20_000 }
    )
    .catch((err: unknown) => {
      if (end !== "rollback") throw err;
    });
  await claimed.opened;
  let tx2Settled = false;
  const tx2 = prisma
    .$transaction((tx) => claimSpreadsheet(tx, b, sheet), { timeout: 20_000 })
    .then(
      () => ({ ok: true as const }),
      (err: unknown) => ({ ok: false as const, err })
    )
    .finally(() => {
      tx2Settled = true;
    });
  await untilBlocked();
  expect(tx2Settled).toBe(false);
  finish.open();
  await tx1;
  const result = await tx2;
  const claims = await prisma.uploadClaim.findMany({
    where: { fileId: sheet },
  });
  return { result, claims };
};

describe("claimSpreadsheet races", () => {
  it("tx1 claims and stays open, tx2 blocks; tx1 commits → tx2 gets SheetInUseError", async () => {
    const { result, claims } = await race("commit");
    expect(result.ok).toBe(false);
    expect(!result.ok && result.err).toBeInstanceOf(SheetInUseError);
    expect(claims.map((c) => c.sourceId)).toEqual([a]);
  });

  it("tx1 rolls back → tx2 wins the claim", async () => {
    const { result, claims } = await race("rollback");
    expect(result.ok).toBe(true);
    expect(claims.map((c) => c.sourceId)).toEqual([b]);
  });
});
