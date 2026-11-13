// @module-tag int
// @module-tag platform
import { fixtureSettings, fixtureTarget } from "../../support/fixtureDb.js";
import { buildVisibleCatalog } from "../../../grants/visibleCatalog.js";
import type { VisibleCatalog } from "../../../grants/visibleCatalog.js";
import { postgresAdapter } from "../../../adapters/postgres/index.js";
import { initializeTereo, stopTereo } from "../../../utils/tereo.js";
import { runPlan, type TestLimits } from "../../support/runPlan.js";
import type { SourceConnection } from "../../../adapters/types.js";
import { sqlQuerySchema } from "../../../adapters/sql/language.js";
import { sealSettings } from "../../../utils/crypto/envelope.js";
import type { SqlPlan } from "../../../adapters/sql/types.js";
import { refreshSource } from "../../../catalog/refresh.js";
import { planSql } from "../../../adapters/sql/plan.js";
import { QueryError } from "../../../engine/errors.js";
import { prisma } from "../../../utils/db/prisma.js";
import { logger } from "../../../utils/logger.js";
import { db } from "../../../utils/db/index.js";
import { randomUUID } from "crypto";
import {
  removeSources,
  sourceSettings,
  uniqueSlug,
} from "../../support/sources.js";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

// Postgres's own types the planner reads as text or number: uuid, enums,
// money, and domains over them (sales.ledger and sales.moods). Each works
// with every operator and aggregate the planner allows for its type.

const LIMITS: TestLimits = {
  maxRows: 1000,
  maxBytes: 10 * 1024 * 1024,
  timeoutMs: 5000,
};

let connection: SourceConnection;
let catalog: VisibleCatalog;
let sourceId: string;

const plan = (query: object): SqlPlan =>
  planSql(
    sqlQuerySchema.parse({ source: catalog.source.slug, ...query }),
    catalog
  );

const rowsOf = async (query: object) =>
  (await runPlan("postgres", connection, plan(query), LIMITS)).rows;

const INVALID_VALUE = {
  code: "invalid_value",
  message: "A value in the query could not be converted to its column's type",
  path: [],
  suggestions: [],
};

const refusalOf = async (query: object) => {
  const err = await runPlan("postgres", connection, plan(query), LIMITS).then(
    () => undefined,
    (e: unknown) => e
  );
  expect(err).toBeInstanceOf(QueryError);
  return err as QueryError;
};

beforeAll(async () => {
  await initializeTereo();
  sourceId = randomUUID();
  await prisma.source.create({
    data: {
      id: sourceId,
      slug: uniqueSlug("pgtypes"),
      name: "Postgres types",
      type: "postgres",
      sealedSettings: sealSettings(sourceSettings("ro"), sourceId) as object,
      schemas: ["sales"],
      createdBy: randomUUID(),
    },
  });
  await refreshSource(sourceId, randomUUID());
  const source = (await db.sources.findById(sourceId))!;
  const { tables, columns, relations } =
    await db.catalog.loadSourceCatalog(sourceId);
  catalog = buildVisibleCatalog(source, tables, columns, relations, {
    sourceIds: new Set([sourceId]),
    allows: () => true,
    tableAccess: () => "all",
  });
  connection = await postgresAdapter.connect(
    fixtureSettings("ro"),
    await fixtureTarget(),
    { connectTimeoutMs: 5000, poolSize: 2, queryTimeoutMs: 5000 }
  );
});

afterAll(async () => {
  await connection.close();
  await removeSources([sourceId]);
  await stopTereo();
});

describe("postgres runQuery: enums", () => {
  it("returns and sorts an enum as text, not in declaration order", async () => {
    expect(await rowsOf({ from: "moods", select: ["mood", "id"] })).toEqual([
      ["happy", 1],
      ["ok", 3],
      ["sad", 2],
    ]);
  });

  it("matches nothing for a label the enum does not have, instead of failing", async () => {
    expect(
      await rowsOf({
        from: "moods",
        select: ["id"],
        where: { mood: { in: ["happy", "Happy", "nope"] } },
      })
    ).toEqual([[1]]);
    expect(
      await rowsOf({
        from: "moods",
        select: ["id"],
        where: { mood: { eq: "nope" } },
      })
    ).toEqual([]);
  });

  it("matches an enum, and a domain over one, ignoring case", async () => {
    expect(
      await rowsOf({
        from: "moods",
        select: ["id"],
        where: { mood: { contains: "AP" } },
      })
    ).toEqual([[1]]);
    expect(
      await rowsOf({
        from: "moods",
        select: ["id"],
        where: { feeling: { startsWith: "S" } },
      })
    ).toEqual([[1]]);
  });

  it("compares and aggregates an enum as text", async () => {
    expect(
      await rowsOf({
        from: "moods",
        select: [
          { min: "mood", as: "lo" },
          { max: "feeling", as: "hi" },
          { countDistinct: "mood", as: "n" },
        ],
      })
    ).toEqual([["happy", "sad", "3"]]);
    expect(
      await rowsOf({
        from: "moods",
        select: ["id"],
        where: { mood: { gt: "ok" } },
      })
    ).toEqual([[2]]);
  });
});

describe("postgres runQuery: money", () => {
  it("returns money, and its sum, as decimal strings without a currency symbol", async () => {
    expect(await rowsOf({ from: "ledger", select: ["id", "amount"] })).toEqual([
      [1, "1234.50"],
      [2, "0.99"],
      [3, "-12.25"],
      [4, null],
    ]);
    expect(
      await rowsOf({
        from: "ledger",
        select: [
          { sum: "amount", as: "s" },
          { min: "amount", as: "lo" },
          { max: "amount", as: "hi" },
        ],
      })
    ).toEqual([["1223.24", "-12.25", "1234.50"]]);
  });

  it("averages money, and a domain over it", async () => {
    expect(
      await rowsOf({
        from: "ledger",
        select: [{ avg: "amount", as: "a" }],
        where: { id: { in: [1, 3] } },
      })
    ).toEqual([[611.125]]);
    expect(
      await rowsOf({ from: "moods", select: [{ avg: "price", as: "a" }] })
    ).toEqual([[6.375]]);
  });

  it("filters money with decimals and integers", async () => {
    expect(
      await rowsOf({
        from: "ledger",
        select: ["id"],
        where: { amount: { gt: "1.5" } },
      })
    ).toEqual([[1]]);
    expect(
      await rowsOf({
        from: "ledger",
        select: ["id"],
        where: { amount: { between: [-13, 1] } },
      })
    ).toEqual([[2], [3]]);
    expect(
      await rowsOf({
        from: "moods",
        select: ["id"],
        where: { price: { gte: 2.25 } },
      })
    ).toEqual([[1], [2]]);
  });
});

describe("postgres runQuery: uuid", () => {
  it("matches a uuid, and a domain over one, as text ignoring case", async () => {
    expect(
      await rowsOf({
        from: "ledger",
        select: ["id"],
        where: { ref: { contains: "8A9B" } },
      })
    ).toEqual([[1]]);
    expect(
      await rowsOf({
        from: "moods",
        select: ["id"],
        where: { token: { startsWith: "A0EE" } },
      })
    ).toEqual([[3]]);
  });

  it("compares a uuid whatever its case, and a domain over one", async () => {
    expect(
      await rowsOf({
        from: "moods",
        select: ["id"],
        where: { token: { eq: "6F1C1B2E-3C4D-4E5F-8A9B-0C1D2E3F4A5B" } },
      })
    ).toEqual([[1]]);
  });

  it("takes min and max of a uuid as text", async () => {
    expect(
      await rowsOf({
        from: "ledger",
        select: [
          { min: "ref", as: "lo" },
          { max: "ref", as: "hi" },
        ],
      })
    ).toEqual([
      [
        "00000000-0000-0000-0000-000000000003",
        "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11",
      ],
    ]);
  });

  it.each([
    ["eq", { eq: "not-a-uuid" }],
    ["in", { in: ["6f1c1b2e-3c4d-4e5f-8a9b-0c1d2e3f4a5b", "nope"] }],
    ["gt on a domain", { gt: "zz" }],
  ])(
    "refuses a malformed uuid (%s) as the caller's value",
    async (_, filter) => {
      const err = await refusalOf({
        from: "moods",
        select: ["id"],
        where: { token: filter },
      });
      expect(err).toMatchObject({ ...INVALID_VALUE, statusCode: 422 });
    }
  );
});

describe("postgres runQuery: citext, char(n) and name", () => {
  it("compares, matches, sorts and aggregates each as text", async () => {
    expect(
      await rowsOf({
        from: "moods",
        select: ["id"],
        where: {
          label: { in: ["ALPHA", "beta"] },
          code: { startsWith: "C" },
          handle: { contains: "M" },
        },
      })
    ).toEqual([[2]]);
    expect(
      await rowsOf({
        from: "moods",
        select: [
          { min: "label", as: "l" },
          { max: "code", as: "c" },
          { min: "handle", as: "h" },
          { countDistinct: "handle", as: "n" },
        ],
      })
    ).toEqual([["alpha", "cd  ", "Amy", "3"]]);
    expect(
      await rowsOf({
        from: "moods",
        select: ["id"],
        where: { handle: { gte: "b" }, code: { ne: "zz" } },
        orderBy: [{ label: "asc" }],
      })
    ).toEqual([[1]]);
  });
});

describe("postgres runQuery: a value the source cannot convert", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** The SQLSTATE of the driver error the refusal was logged with. */
  const loggedCode = (info: { mock: { calls: unknown[][] } }) =>
    info.mock.calls
      .map(([meta]) => (meta as { err?: { code?: string } })?.err?.code)
      .find((code) => code !== undefined);

  it.each([
    [
      "a malformed uuid",
      "22P02",
      { from: "ledger", select: ["id"], where: { ref: { eq: "not-a-uuid" } } },
    ],
    [
      "a timestamp offset Postgres does not take",
      "22009",
      {
        from: "orders",
        select: ["id"],
        where: { created_at: { gt: "2026-01-01T00:00:00+16:00" } },
      },
    ],
    [
      "a number past numeric's range",
      "22003",
      {
        from: "orders",
        select: ["id"],
        where: { total: { gt: "9".repeat(140_000) } },
      },
    ],
  ])("refuses %s (%s) as invalid_value", async (_, code, query) => {
    const info = vi.spyOn(logger, "info");
    const err = await refusalOf(query);
    expect(err).toMatchObject(INVALID_VALUE);
    expect(loggedCode(info)).toBe(code);
  });
});
