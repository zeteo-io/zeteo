// @module-tag int
// @module-tag platform
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { registerSource, tableOf } from "../support/grants.js";
import type { RuleFilter } from "../../row-rules/types.js";
import { removeSources } from "../support/sources.js";
import { startV1Routes } from "../support/v1App.js";
import { prisma } from "../../utils/db/prisma.js";
import { randomUUID } from "crypto";
import {
  ruleNamesFor,
  ruleProblems,
  toApiRule,
  toStoredRule,
} from "../../row-rules/store.js";

describe("row-rules store", () => {
  let app: Awaited<ReturnType<typeof startV1Routes>>;
  let sourceId: string;
  let tableId: string;
  const ids = new Map<string, string>();
  const keyName = `store_${randomUUID().slice(0, 8)}`;
  let keyId: string;

  const store = (rule: RuleFilter) =>
    prisma.$transaction((tx) => toStoredRule(tx, tableId, rule));

  beforeAll(async () => {
    app = await startV1Routes();
    sourceId = await registerSource(app.url);
    tableId = (await tableOf(sourceId, "orders")).id;
    for (const c of await prisma.sourceColumn.findMany({ where: { tableId } }))
      ids.set(c.name, c.id);
    keyId = (
      await prisma.identityKey.create({
        data: { name: keyName, label: "K", createdBy: randomUUID() },
      })
    ).id;
  });
  afterAll(async () => {
    await removeSources([sourceId]);
    await prisma.identityKey.deleteMany({ where: { id: keyId } });
    await app.close();
  });

  it("keys the rule by column id and identity key id, and round-trips to names", async () => {
    const rule: RuleFilter = {
      or: [
        { status: { notIn: { identity: keyName } }, total: { gte: "10.5" } },
        { not: { notes: { ne: { identity: keyName } } } },
        {
          created_at: {
            between: [
              "2026-01-01T00:00:00Z",
              { relative: { unit: "day", offset: 0 } },
            ],
          },
        },
      ],
    };
    const { stored, identityKeyIds } = await store(rule);
    expect(identityKeyIds).toEqual([keyId]);
    expect(stored).toEqual({
      or: [
        {
          [ids.get("status")!]: { notIn: { identity: keyId } },
          [ids.get("total")!]: { gte: "10.5" },
        },
        { not: { [ids.get("notes")!]: { ne: { identity: keyId } } } },
        {
          [ids.get("created_at")!]: {
            between: [
              "2026-01-01T00:00:00Z",
              { relative: { unit: "day", offset: 0 } },
            ],
          },
        },
      ],
    });
    const names = await ruleNamesFor([stored]);
    expect(toApiRule(stored, names.columns, names.keys)).toEqual(rule);
    expect(ruleProblems(stored, names.columns, names.keys)).toEqual([]);
  });

  it("refuses a relative date on a text column", async () => {
    await expect(
      store({ status: { eq: { relative: { unit: "day", offset: 0 } } } })
    ).rejects.toMatchObject({
      code: "invalid_row_rule",
      details: { path: ["row_rule", "status", "eq"] },
    });
  });

  it("refuses a bad value inside a list at its index", async () => {
    await expect(store({ total: { in: ["1", "x"] } })).rejects.toMatchObject({
      code: "invalid_row_rule",
      details: { path: ["row_rule", "total", "in", 1] },
    });
  });

  it("names unknown ids as problems and keeps them", () => {
    const col = randomUUID();
    const key = randomUUID();
    const stored = { [col]: { in: { identity: key } } };
    expect(toApiRule(stored, new Map(), new Map())).toEqual(stored);
    expect(ruleProblems(stored, new Map(), new Map())).toEqual([
      `column_unknown:${col}`,
      `identity_key_unknown:${key}`,
    ]);
  });
});
