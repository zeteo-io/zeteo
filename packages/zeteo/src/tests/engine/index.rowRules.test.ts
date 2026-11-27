// @module-tag int
// @module-tag platform
import { ndjsonLines, newExportUser, postExport } from "../support/exports.js";
import { describeEachEngine, type EngineFixture } from "../support/engines.js";
import { savedQueriesCall, shareDirectly } from "../support/savedQueries.js";
import { clearTestGroups, setTestGroups } from "../support/principals.js";
import { removeSources, writeToken } from "../support/sources.js";
import { fixtureAdminSettings } from "../support/fixtureDb.js";
import { closeAllSourcePools } from "../../sources/pools.js";
import type { RuleFilter } from "../../row-rules/types.js";
import { asMssqlAdmin } from "../support/mssqlFixture.js";
import { BASE_URL, fetchJson } from "../support/http.js";
import { afterAll, beforeAll, expect, it } from "vitest";
import { TABLE } from "../support/dashboards.js";
import { prisma } from "../../utils/db/index.js";
import { tokenFor } from "../support/tokens.js";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import {
  dashboardWith,
  removeDashboardsOf,
} from "../support/panelDecisions.js";
import {
  grantTo,
  newQueryUser,
  postQuery,
  removeRunsOf,
  seedQuerySource,
  type SeededSource,
} from "../support/queries.js";

// Every query reads only the rows the caller's row rules keep, on both
// engines: the from table, every join (left keeps the row with nulls, inner
// drops it), aggregates, exports and saved queries run by a recipient.

/** Orders by status in the fixture. */
const PAID_IDS = [1, 2, 4, 6, 8, 10, 12];
/** Customer 2 is the fixture's one US customer; 1 and 3 are EU. */
const US_ORDER_IDS = [3, 5, 8, 11];

describeEachEngine("row rules", (engine) => {
  let source: SeededSource;
  const admin = newQueryUser();
  const paid = newExportUser();
  const euCustomers = newQueryUser();
  const lines = newQueryUser();
  const owner = newQueryUser();
  const recipient = newQueryUser();
  const recent = newQueryUser();
  const many = newQueryUser();
  const manyText = newQueryUser();
  const missing = newQueryUser();
  const bigRef = newQueryUser();
  const list100 = newQueryUser();
  const list101 = newQueryUser();
  const orgMember = newQueryUser();
  const ORG = randomUUID();
  const orgGroup = randomUUID();
  const globalGroup = randomUUID();
  const users = [
    orgMember,
    list100,
    list101,
    admin,
    paid,
    euCustomers,
    lines,
    owner,
    recipient,
    recent,
    many,
    manyText,
    missing,
    bigRef,
  ];
  const keyIds: string[] = [];

  const ok = async (token: string, body: Record<string, unknown>) => {
    const res = await postQuery(token, { source: source.slug, ...body });
    if (res.status !== 200) {
      throw new Error(`${res.status} ${JSON.stringify(res.body)}`);
    }
    return res.body.rows as unknown[][];
  };
  const ids = (rows: unknown[][]) =>
    rows.map((r) => Number(r[0])).sort((a, b) => a - b);

  beforeAll(async () => {
    source = await seedQuerySource(
      engine,
      { export_enabled: true, export_row_cap: 1_000_000 },
      "rowrules"
    );
    const { orders, customers, order_lines } = source.tables;
    await grantTo(admin.principal, orders!, "all");
    await grantTo(admin.principal, customers!, "all");
    await grantTo(admin.principal, order_lines!, "all");

    await grantTo(paid.principal, orders!, "all", {
      access: "rule",
      rule: { status: { in: ["paid"] } },
    });
    await grantTo(paid.principal, customers!, "all");
    for (const [name, fixed] of [
      ["order_count", false],
      ["all_orders", true],
    ] as const) {
      await prisma.measure.create({
        data: {
          sourceId: source.id,
          tableId: orders!.id,
          name,
          description: `The ${name}`,
          formula: { count: "*" },
          fixed,
          dateColumn: "created_at",
          createdBy: admin.id,
          updatedBy: admin.id,
        },
      });
    }

    await grantTo(euCustomers.principal, orders!, "all");
    await grantTo(euCustomers.principal, customers!, "all", {
      access: "rule",
      rule: { region: { eq: "EU" } },
    });

    await grantTo(lines.principal, orders!, "all");
    await grantTo(lines.principal, order_lines!, "all", {
      access: "rule",
      rule: { sku: { eq: "big-a" } },
    });

    await grantTo(owner.principal, orders!, "all", {
      access: "rule",
      rule: { status: { in: ["paid", "shipped"] } },
    });
    await grantTo(recipient.principal, orders!, "all", {
      access: "rule",
      rule: { status: { eq: "shipped" } },
    });

    await grantTo(recent.principal, orders!, "all", {
      access: "rule",
      rule: {
        created_at: { gte: { relative: { unit: "day", offset: -90 } } },
      },
    });

    // An identity rule with 3,000 values: orders 6 to 12 among them.
    const key = await prisma.identityKey.create({
      data: {
        name: `order_${randomUUID().slice(0, 8)}`,
        label: "Order",
        createdBy: admin.id,
      },
    });
    keyIds.push(key.id);
    await prisma.identityValue.createMany({
      data: Array.from({ length: 3000 }, (_, i) => ({
        keyId: key.id,
        userId: many.id,
        value: String(i + 6),
        createdBy: admin.id,
      })),
    });
    await grantTo(many.principal, orders!, "all", {
      access: "rule",
      rule: { id: { in: { identity: key.name } } },
    });

    // 200 text values, "shipped" among them: one list on a text column.
    const textKey = await prisma.identityKey.create({
      data: {
        name: `status_${randomUUID().slice(0, 8)}`,
        label: "Status",
        createdBy: admin.id,
      },
    });
    keyIds.push(textKey.id);
    await prisma.identityValue.createMany({
      data: ["shipped", ...Array.from({ length: 199 }, (_, i) => `s${i}`)].map(
        (value) => ({
          keyId: textKey.id,
          userId: manyText.id,
          value,
          createdBy: admin.id,
        })
      ),
    });
    await grantTo(manyText.principal, orders!, "all", {
      access: "rule",
      rule: { status: { in: { identity: textKey.name } } },
    });

    // 2^53 + 1, as a decimal string: as a JS number it would be 2^53.
    await grantTo(bigRef.principal, orders!, "all", {
      access: "rule",
      rule: { external_ref: { eq: "9007199254740993" } },
    });

    // One rule as a list of 100 values (a parameter each) and of 101 (one
    // list): 7 is order 8's; 2^53 is order 2's neighbour (2^53 + 1), the
    // same number as a float; the 39-digit value fits no bigint or decimal.
    const odd = ["7", "9007199254740992", "1" + "0".repeat(38), "8.5"];
    const filler = (n: number) =>
      Array.from({ length: n }, (_, i) => String(1_000_001 + i));
    await grantTo(list100.principal, orders!, "all", {
      access: "rule",
      rule: { external_ref: { in: [...odd, ...filler(96)] } },
    });
    await grantTo(list101.principal, orders!, "all", {
      access: "rule",
      rule: { external_ref: { in: [...odd, ...filler(97)] } },
    });

    // The rule is on a group of organization ORG; a global group's grant
    // does not limit rows.
    await grantTo({ type: "group", id: orgGroup }, orders!, "all", {
      access: "rule",
      rule: { status: { eq: "paid" } },
    });
    await grantTo({ type: "group", id: globalGroup }, orders!, [
      "id",
      "status",
    ]);
    await setTestGroups(orgMember.id, [
      { id: orgGroup, organizationId: ORG },
      { id: globalGroup, organizationId: null },
    ]);

    await grantTo(missing.principal, orders!, "all", {
      access: "rule",
      rule: { notes: { isNull: true } },
    });
  });
  afterAll(async () => {
    await clearTestGroups(orgMember.id);
    await removeDashboardsOf([missing.id]);
    await removeRunsOf(users.map((u) => u.id));
    await removeSources([source.id]);
    await prisma.identityValue.deleteMany({ where: { keyId: { in: keyIds } } });
    await prisma.identityKey.deleteMany({ where: { id: { in: keyIds } } });
    await closeAllSourcePools();
  });

  it("returns only the rule's rows, as many as an admin's filtered query", async () => {
    const rows = await ok(paid.token, {
      from: "orders",
      select: ["id", "status"],
    });
    expect(rows.every((r) => r[1] === "paid")).toBe(true);
    expect(ids(rows)).toEqual(PAID_IDS);
    const filtered = await ok(admin.token, {
      from: "orders",
      select: ["id"],
      where: { status: { eq: "paid" } },
    });
    expect(rows).toHaveLength(filtered.length);
  });

  it("matches a bigint past 2^53 exactly, given as a decimal string", async () => {
    const rows = await ok(bigRef.token, {
      from: "orders",
      select: ["id", "external_ref"],
    });
    expect(ids(rows)).toEqual([2]);
    expect(String(rows[0]![1])).toBe("9007199254740993");
  });

  it("keeps the same rows for a list of 100 values and of 101, never comparing a bigint through a float", async () => {
    const short = await ok(list100.token, { from: "orders", select: ["id"] });
    const long = await ok(list101.token, { from: "orders", select: ["id"] });
    expect(ids(short)).toEqual([8]);
    expect(ids(long)).toEqual([8]);
  });

  // By design (docs/row-rules.md, "Organization-scoped groups"): a rule on
  // an organization's group counts only when the user is signed in to that
  // organization. Signed in to another organization, or to none, it drops
  // out, and a global grant that does not limit rows gives every row.
  it("applies an organization-scoped group's rule only under a sign-in to that organization", async () => {
    const as = (org?: string) =>
      tokenFor({
        userId: orgMember.id,
        permissions: ["zeteo.data.read"],
        ...(org && { org }),
      });
    const query = { from: "orders", select: ["id"] };
    expect(ids(await ok(as(ORG), query))).toEqual(PAID_IDS);
    const every = Array.from({ length: 12 }, (_, i) => i + 1);
    expect(ids(await ok(as(), query))).toEqual(every);
    expect(ids(await ok(as(randomUUID()), query))).toEqual(every);
  });

  it("counts and sums only the rule's rows", async () => {
    const [[count, sum]] = (await ok(paid.token, {
      from: "orders",
      select: [{ count: "*" }, { sum: "total" }],
    })) as [[unknown, unknown]];
    const [[adminCount, adminSum]] = (await ok(admin.token, {
      from: "orders",
      select: [{ count: "*" }, { sum: "total" }],
      where: { status: { eq: "paid" } },
    })) as [[unknown, unknown]];
    expect(Number(count)).toBe(PAID_IDS.length);
    expect(Number(count)).toBe(Number(adminCount));
    expect(Number(sum)).toBe(Number(adminSum));
  });

  it("counts only the rule's rows in a measure, a fixed measure from another table and a metric query", async () => {
    const [[count]] = (await ok(paid.token, {
      from: "orders",
      select: [{ measure: "order_count" }],
    })) as [[unknown]];
    expect(Number(count)).toBe(PAID_IDS.length);

    const fromCustomers = await ok(paid.token, {
      from: "customers",
      select: ["id", { measure: "all_orders" }],
      groupBy: ["id"],
    });
    expect(fromCustomers).toHaveLength(3);
    expect(fromCustomers.every((r) => Number(r[1]) === PAID_IDS.length)).toBe(
      true
    );
    const [[adminFixed]] = (await ok(admin.token, {
      from: "orders",
      select: [{ measure: "all_orders" }],
    })) as [[unknown]];
    expect(Number(adminFixed)).toBe(12);

    const byMonth = await ok(paid.token, {
      metrics: ["order_count", "all_orders"],
      bucket: "month",
    });
    expect(byMonth.reduce((n, r) => n + Number(r[1]), 0)).toBe(PAID_IDS.length);
    expect(byMonth.every((r) => Number(r[2]) === PAID_IDS.length)).toBe(true);
  });

  it("keeps every order on a left join, the hidden customer's columns null", async () => {
    const rows = await ok(euCustomers.token, {
      from: "orders",
      join: [{ relation: "customers", type: "left" }],
      select: ["id", "customers.name", "customers.region"],
    });
    expect(rows).toHaveLength(12);
    for (const [id, name, region] of rows) {
      if (US_ORDER_IDS.includes(Number(id))) {
        expect([name, region]).toEqual([null, null]);
      } else {
        expect(region).toBe("EU");
      }
    }
  });

  it("drops the orders of a hidden customer on an inner join", async () => {
    const rows = await ok(euCustomers.token, {
      from: "orders",
      join: ["customers"],
      select: ["id", "customers.region"],
    });
    expect(ids(rows)).toEqual(
      Array.from({ length: 12 }, (_, i) => i + 1).filter(
        (id) => !US_ORDER_IDS.includes(id)
      )
    );
    expect(rows.every((r) => r[1] === "EU")).toBe(true);
  });

  it("reads a to-many join's table through its rule", async () => {
    const rows = await ok(lines.token, {
      from: "orders",
      join: [{ relation: "order_lines", type: "left" }],
      select: ["id", "order_lines.sku"],
      where: { id: { eq: 2 } },
    });
    expect(rows.map((r) => r[1])).toEqual(["big-a"]);
    const all = await ok(admin.token, {
      from: "orders",
      join: [{ relation: "order_lines", type: "left" }],
      select: ["id", "order_lines.sku"],
      where: { id: { eq: 2 } },
    });
    expect(all).toHaveLength(2);
  });

  it("exports only the rule's rows", async () => {
    const res = await postExport({
      token: paid.token,
      body: { source: source.slug, from: "orders", select: ["id", "status"] },
    });
    expect(res.status).toBe(200);
    // The head, a row per line, the tail.
    const lines = ndjsonLines(res.text);
    const rows = lines.slice(1, -1) as unknown[][];
    expect(lines.at(-1)).toEqual({ status: "complete", rows: PAID_IDS.length });
    expect(ids(rows)).toEqual(PAID_IDS);
    expect(rows.every((r) => r[1] === "paid")).toBe(true);
  });

  it("runs a shared saved query with the recipient's own narrower rule", async () => {
    const created = await savedQueriesCall("POST", "", owner.token, {
      name: `orders ${randomUUID().slice(0, 8)}`,
      query: { source: source.slug, from: "orders", select: ["id", "status"] },
    });
    expect(created.status).toBe(201);
    const id = created.body.id as string;
    await shareDirectly(id, recipient.principal, owner.id);

    const own = await savedQueriesCall("POST", `/${id}/run`, owner.token, {});
    expect(own.status).toBe(200);
    expect(new Set((own.body.rows as unknown[][]).map((r) => r[1]))).toEqual(
      new Set(["paid", "shipped"])
    );

    const theirs = await savedQueriesCall(
      "POST",
      `/${id}/run`,
      recipient.token,
      {}
    );
    expect(theirs.status).toBe(200);
    const rows = theirs.body.rows as unknown[][];
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r[1] === "shipped")).toBe(true);
  });

  it("resolves a relative rule against the query's now, as a where would", async () => {
    const since = { gte: { relative: { unit: "day", offset: -90 } } };
    const rows = await ok(recent.token, { from: "orders", select: ["id"] });
    const filtered = await ok(admin.token, {
      from: "orders",
      select: ["id"],
      where: { created_at: since },
    });
    expect(ids(rows)).toEqual(ids(filtered));
  });

  it("runs an identity rule of 3,000 values", async () => {
    const rows = await ok(many.token, { from: "orders", select: ["id"] });
    expect(ids(rows)).toEqual([6, 7, 8, 9, 10, 11, 12]);
  });

  it("runs an identity rule of 200 text values against a text column", async () => {
    const rows = await ok(manyText.token, {
      from: "orders",
      select: ["id", "status"],
    });
    expect(ids(rows)).toEqual([3, 7, 11]);
  });

  it("refuses a table whose rule's column has gone missing with 409, never unfiltered", async () => {
    const before = await ok(missing.token, { from: "orders", select: ["id"] });
    expect(ids(before)).toEqual([1, 3, 5, 7, 9, 11]);
    const created = await savedQueriesCall("POST", "", missing.token, {
      name: `orders ${randomUUID().slice(0, 8)}`,
      query: { source: source.slug, from: "orders", select: ["id"] },
    });
    expect(created.status).toBe(201);
    const savedId = created.body.id as string;
    const dashboard = await dashboardWith(missing.id, [
      { kind: "own", savedQueryId: savedId, chart: TABLE },
    ]);
    const notes = source.tables.orders!.columns.notes!;
    await prisma.sourceColumn.update({
      where: { id: notes },
      data: { missingSince: new Date() },
    });
    try {
      const res = await postQuery(missing.token, {
        source: source.slug,
        from: "orders",
        select: ["id"],
      });
      expect(res.status).toBe(409);
      expect(res.body.error).toBe("row_rule_unavailable");

      // A saved query stays the caller's to use: only its run is refused.
      const got = await savedQueriesCall("GET", `/${savedId}`, missing.token);
      expect(got.status).toBe(200);
      expect(got.body.accessible).toBe(true);
      const run = await savedQueriesCall(
        "POST",
        `/${savedId}/run`,
        missing.token,
        {}
      );
      expect(run.status).toBe(409);
      expect(run.body.error).toBe("row_rule_unavailable");

      // So does a dashboard panel on it: its line carries the run's error.
      const panels = await postExport({
        token: missing.token,
        body: {},
        path: `/v1/dashboards/${dashboard.id}/run`,
      });
      expect(panels.status).toBe(200);
      const [line] = ndjsonLines(panels.text) as Array<{
        state: string;
        error?: { error: string };
      }>;
      expect(line).toMatchObject({
        panel_id: dashboard.panels[0]!.id,
        state: "ok",
        error: { error: "row_rule_unavailable" },
      });
    } finally {
      await prisma.sourceColumn.update({
        where: { id: notes },
        data: { missingSince: null },
      });
    }
  });
});

// A column widened after the catalogue was read (an id past int, a decimal
// given a scale), with no refresh since: the catalogue still says the old
// type. A rule's ne, notIn or not around in must never show the rows holding
// a value the old type could not: both engines refuse the query (409
// row_rule_unavailable), SQL Server's guard and Postgres's live check
// finding the rule's column changed, until the source is refreshed.
const DRIFT_SCHEMA = "rr_drift";

const asFixtureAdmin = async (
  engine: EngineFixture,
  statements: { postgres: string[]; mssql: string[] }
): Promise<void> => {
  if (engine.type === "azure-sql") {
    await asMssqlAdmin(statements.mssql);
    return;
  }
  const admin = new Client({ ...fixtureAdminSettings(), ssl: false });
  await admin.connect();
  try {
    for (const statement of statements.postgres) await admin.query(statement);
  } finally {
    await admin.end();
  }
};

describeEachEngine(
  "row rules on a column widened since the catalogue was read",
  (engine) => {
    let source: SeededSource;
    const notIn = newQueryUser();
    const notAroundIn = newQueryUser();
    const ne = newQueryUser();
    const decimalNotIn = newQueryUser();
    const longNotIn = newQueryUser();
    const users = [notIn, notAroundIn, ne, decimalNotIn, longNotIn];
    const drop = {
      postgres: [`DROP SCHEMA IF EXISTS ${DRIFT_SCHEMA} CASCADE`],
      mssql: [
        `DROP TABLE IF EXISTS ${DRIFT_SCHEMA}.accounts`,
        `DROP SCHEMA IF EXISTS ${DRIFT_SCHEMA}`,
      ],
    };

    beforeAll(async () => {
      await asFixtureAdmin(engine, drop);
      await asFixtureAdmin(engine, {
        postgres: [
          `CREATE SCHEMA ${DRIFT_SCHEMA}`,
          `CREATE TABLE ${DRIFT_SCHEMA}.accounts (id integer PRIMARY KEY, ref integer, amount numeric(10,0))`,
          `INSERT INTO ${DRIFT_SCHEMA}.accounts VALUES (1, 1, 1), (2, 2, 2), (3, NULL, NULL)`,
          `GRANT USAGE ON SCHEMA ${DRIFT_SCHEMA} TO zeteo_ro`,
          `GRANT SELECT ON ${DRIFT_SCHEMA}.accounts TO zeteo_ro`,
        ],
        mssql: [
          `CREATE SCHEMA ${DRIFT_SCHEMA}`,
          `CREATE TABLE ${DRIFT_SCHEMA}.accounts (id int NOT NULL PRIMARY KEY, ref int, amount decimal(10,0))`,
          `INSERT INTO ${DRIFT_SCHEMA}.accounts VALUES (1, 1, 1), (2, 2, 2), (3, NULL, NULL)`,
          `GRANT SELECT ON SCHEMA::${DRIFT_SCHEMA} TO zeteo_ro`,
        ],
      });
      source = await seedQuerySource(
        engine,
        { schemas: [DRIFT_SCHEMA] },
        "rrdrift"
      );
      const accounts = source.tables.accounts!;
      // Widened behind the catalogue's back: it still says int and (10,0).
      await asFixtureAdmin(engine, {
        postgres: [
          `ALTER TABLE ${DRIFT_SCHEMA}.accounts ALTER COLUMN ref TYPE bigint, ALTER COLUMN amount TYPE numeric(12,2)`,
          `INSERT INTO ${DRIFT_SCHEMA}.accounts VALUES (4, 3000000000, 5.25), (5, 4000000000, 7)`,
        ],
        mssql: [
          `ALTER TABLE ${DRIFT_SCHEMA}.accounts ALTER COLUMN ref bigint`,
          `ALTER TABLE ${DRIFT_SCHEMA}.accounts ALTER COLUMN amount decimal(12,2)`,
          `INSERT INTO ${DRIFT_SCHEMA}.accounts VALUES (4, 3000000000, 5.25), (5, 4000000000, 7)`,
        ],
      });
      const rules: [typeof notIn, RuleFilter][] = [
        [notIn, { ref: { notIn: ["3000000000"] } }],
        [notAroundIn, { not: { ref: { in: ["3000000000", "4000000000"] } } }],
        [ne, { ref: { ne: "4000000000" } }],
        [decimalNotIn, { amount: { notIn: ["5.25"] } }],
        [
          longNotIn,
          {
            ref: {
              notIn: [
                "3000000000",
                ...Array.from({ length: 120 }, (_, i) => String(1_000_001 + i)),
              ],
            },
          },
        ],
      ];
      for (const [user, rule] of rules) {
        await grantTo(user.principal, accounts, "all", {
          access: "rule",
          rule,
        });
      }
    });
    afterAll(async () => {
      await removeRunsOf(users.map((u) => u.id));
      await removeSources([source.id]);
      await closeAllSourcePools();
      await asFixtureAdmin(engine, drop);
    });

    it.each([
      ["notIn", notIn],
      ["not around in", notAroundIn],
      ["ne", ne],
      ["notIn on a decimal given a scale", decimalNotIn],
      ["a notIn of 121 values", longNotIn],
    ] as const)(
      "refuses the query rather than compare in the old type (%s)",
      async (_, user) => {
        const res = await postQuery(user.token, {
          source: source.slug,
          from: "accounts",
          select: ["id"],
        });
        expect(res.status).toBe(409);
        expect(res.body).toMatchObject({
          error: "row_rule_unavailable",
          error_description:
            "Your access to accounts can't be applied right now; ask an admin",
          path: ["from"],
        });
        expect(JSON.stringify(res.body)).not.toMatch(
          /sys\.columns|51000|pg_|bigint|numeric/
        );
      }
    );

    it("reads the rows again once the source is refreshed", async () => {
      const refreshed = await fetchJson(
        "POST",
        `${BASE_URL}/v1/sources/${source.id}/refresh`,
        writeToken()
      );
      expect(refreshed.status).toBe(200);
      for (const [user, expected] of [
        [notIn, [1, 2, 5]],
        [ne, [1, 2, 4]],
        [decimalNotIn, [1, 2, 5]],
      ] as const) {
        const res = await postQuery(user.token, {
          source: source.slug,
          from: "accounts",
          select: ["id"],
        });
        expect(res.status).toBe(200);
        expect(
          (res.body.rows as unknown[][])
            .map((r) => Number(r[0]))
            .sort((a, b) => a - b)
        ).toEqual(expected);
      }
    });
  }
);
