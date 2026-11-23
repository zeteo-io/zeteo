// @module-tag int
// @module-tag platform
import { ndjsonLines, newExportUser, postExport } from "../support/exports.js";
import { savedQueriesCall, shareDirectly } from "../support/savedQueries.js";
import { closeAllSourcePools } from "../../sources/pools.js";
import { describeEachEngine } from "../support/engines.js";
import { afterAll, beforeAll, expect, it } from "vitest";
import { removeSources } from "../support/sources.js";
import { TABLE } from "../support/dashboards.js";
import { prisma } from "../../utils/db/index.js";
import { randomUUID } from "node:crypto";
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
  const users = [
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

    await grantTo(missing.principal, orders!, "all", {
      access: "rule",
      rule: { notes: { isNull: true } },
    });
  });
  afterAll(async () => {
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
