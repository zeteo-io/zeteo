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

  it("refuses a JSON number that was rounded in parsing, asking for a decimal string", async () => {
    // 9007199254740993 written in JSON arrives as 2^53.
    await expect(store({ total: { eq: 2 ** 53 } })).rejects.toMatchObject({
      code: "invalid_row_rule",
      message: expect.stringContaining(
        "write large numbers as decimal strings"
      ),
      details: { path: ["row_rule", "total", "eq"] },
    });
    await expect(
      store({ total: { in: [1, 1.2345678901234567] } })
    ).rejects.toMatchObject({
      code: "invalid_row_rule",
      details: { path: ["row_rule", "total", "in", 1] },
    });
    await expect(
      store({ total: { between: [0, 1e21] } })
    ).rejects.toMatchObject({
      code: "invalid_row_rule",
      details: { path: ["row_rule", "total", "between", 1] },
    });
    const { stored } = await store({
      total: {
        in: [2 ** 53 - 1, -(2 ** 53 - 1), 0.1, 12.5, "9007199254740993"],
      },
    });
    expect(stored).toEqual({
      [ids.get("total")!]: {
        in: [2 ** 53 - 1, -(2 ** 53 - 1), 0.1, 12.5, "9007199254740993"],
      },
    });
  });

  it("refuses an ordering bound of more than 38 digits, which SQL Server would compare through a float", async () => {
    const long = "0.123456789000000000000000000000000000001";
    for (const [condition, path] of [
      [{ gte: long }, ["row_rule", "total", "gte"]],
      [{ lt: "1" + "0".repeat(38) }, ["row_rule", "total", "lt"]],
      [
        { between: ["0", "1." + "0".repeat(38)] },
        ["row_rule", "total", "between", 1],
      ],
    ] as const) {
      await expect(store({ total: condition as never })).rejects.toMatchObject({
        code: "invalid_row_rule",
        message: expect.stringContaining("more than 38 digits"),
        details: { path },
      });
    }
    // 38 digits bind exactly; an equality of more is compared exactly or
    // fails closed when the query runs.
    await store({
      and: [
        { total: { gte: "0." + "1".repeat(38) } },
        { total: { lte: "9".repeat(38) } },
      ],
    });
    await store({ total: { notIn: ["1" + "0".repeat(38)] } });
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
