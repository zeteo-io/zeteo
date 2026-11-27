// @module-tag int
// @module-tag platform
import { ndjsonLines, newExportUser, postExport } from "../support/exports.js";
import { savedQueriesCall } from "../support/savedQueries.js";
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
  clearTestReports,
  failTestReports,
  setTestReports,
} from "../support/hierarchy.js";
import {
  grantTo,
  newQueryUser,
  postQuery,
  removeRunsOf,
  seedQuerySource,
  type SeededSource,
} from "../support/queries.js";

// A rule with `below` keeps the rows of the caller's values and of the values
// of everyone below them in tereo's reporting lines (stubbed through the
// test-mode seam), deactivated users included. When tereo cannot say who is
// below, the query is refused: never the caller's own rows, never every row.

describeEachEngine("row rules with below", (engine) => {
  let source: SeededSource;
  let keyName: string;
  let keyId: string;
  let savedId: string;
  let dashboardId: string;
  let panelId: string;

  const director = newQueryUser();
  /** Deactivated in tereo, still in the chain: tereo lists them, values kept. */
  const manager = newQueryUser();
  const rep = newQueryUser();
  const otherRep = newQueryUser();
  const lone = newQueryUser();
  const noOwn = newQueryUser();
  const nobody = newQueryUser();
  const valueless = newQueryUser();
  const down = newExportUser();
  const tooMany = newQueryUser();
  const plain = newQueryUser();
  const reorg = newQueryUser();
  const users = [
    director,
    manager,
    rep,
    otherRep,
    lone,
    noOwn,
    nobody,
    valueless,
    down,
    tooMany,
    plain,
    reorg,
  ];

  const query = (token: string) =>
    postQuery(token, { source: source.slug, from: "orders", select: ["id"] });
  const ids = async (token: string) => {
    const res = await query(token);
    if (res.status !== 200) {
      throw new Error(`${res.status} ${JSON.stringify(res.body)}`);
    }
    return (res.body.rows as unknown[][])
      .map((r) => Number(r[0]))
      .sort((a, b) => a - b);
  };

  beforeAll(async () => {
    source = await seedQuerySource(
      engine,
      { export_enabled: true, export_row_cap: 1_000_000 },
      "rowbelow"
    );
    const orders = source.tables.orders!;
    keyName = `order_${randomUUID().slice(0, 8)}`;
    keyId = (
      await prisma.identityKey.create({
        data: { name: keyName, label: "Order", createdBy: director.id },
      })
    ).id;
    // A value means one person within its key: each order id held by one user.
    const held: Array<[{ id: string }, string]> = [
      [director, "1"],
      [rep, "2"],
      [otherRep, "4"],
      [manager, "5"],
      [lone, "6"],
      [plain, "7"],
      [down, "8"],
      [tooMany, "9"],
    ];
    await prisma.identityValue.createMany({
      data: held.map(([user, value]) => ({
        keyId,
        userId: user.id,
        value,
        createdBy: director.id,
      })),
    });

    const below = { id: { in: { identity: keyName, below: true } } };
    for (const user of [director, lone, noOwn, nobody, down, tooMany, reorg]) {
      await grantTo(user.principal, orders, "all", {
        access: "rule",
        rule: below,
      });
    }
    await grantTo(plain.principal, orders, "all", {
      access: "rule",
      rule: { id: { in: { identity: keyName } } },
    });

    await setTestReports(director.id, [manager.id, rep.id]);
    await setTestReports(noOwn.id, [rep.id]);
    await setTestReports(nobody.id, [valueless.id]);
    await setTestReports(reorg.id, [rep.id]);

    // The dashboard's saved query is created while tereo answers.
    const created = await savedQueriesCall("POST", "", down.token, {
      name: `orders ${randomUUID().slice(0, 8)}`,
      query: { source: source.slug, from: "orders", select: ["id"] },
    });
    expect(created.status).toBe(201);
    savedId = created.body.id as string;
    const dashboard = await dashboardWith(down.id, [
      { kind: "own", savedQueryId: savedId, chart: TABLE },
    ]);
    dashboardId = dashboard.id;
    panelId = dashboard.panels[0]!.id;
    await failTestReports(down.id, "unavailable");
    await failTestReports(tooMany.id, "too_large");
    // A rule without below never asks tereo, so this failure is never seen.
    await failTestReports(plain.id, "unavailable");
  });
  afterAll(async () => {
    for (const user of users) await clearTestReports(user.id);
    await removeDashboardsOf([down.id]);
    await prisma.savedQuery.deleteMany({ where: { ownerId: down.id } });
    await removeRunsOf(users.map((u) => u.id));
    await removeSources([source.id]);
    await prisma.identityValue.deleteMany({ where: { keyId } });
    await prisma.identityKey.deleteMany({ where: { id: keyId } });
    await closeAllSourcePools();
  });

  it("keeps the rows of the caller and of everyone below, through a deactivated manager", async () => {
    expect(await ids(director.token)).toEqual([1, 2, 5]);
  });

  it("gives a caller with no reports exactly their own rows", async () => {
    expect(await ids(lone.token)).toEqual([6]);
  });

  it("gives a caller with no value of their own the rows of those below", async () => {
    expect(await ids(noOwn.token)).toEqual([2]);
  });

  it("gives no row when neither the caller nor anyone below holds a value", async () => {
    expect(await ids(nobody.token)).toEqual([]);
  });

  it("follows a reorganisation at the next query", async () => {
    expect(await ids(reorg.token)).toEqual([2]);
    await setTestReports(reorg.id, [otherRep.id]);
    expect(await ids(reorg.token)).toEqual([4]);
  });

  it("never asks tereo for a rule without below", async () => {
    expect(await ids(plain.token)).toEqual([7]);
  });

  it("refuses a query with 503 when tereo cannot say who is below", async () => {
    const res = await query(down.token);
    expect(res.status).toBe(503);
    expect(res.body.error).toBe("row_rule_unavailable");
    expect(res.body).not.toHaveProperty("rows");
  });

  it("refuses an export with 503 when tereo cannot say who is below", async () => {
    const res = await postExport({
      token: down.token,
      body: { source: source.slug, from: "orders", select: ["id"] },
    });
    expect(res.status).toBe(503);
    expect(JSON.parse(res.text).error).toBe("row_rule_unavailable");
  });

  it("refuses a saved query's run and a dashboard panel when tereo cannot say who is below", async () => {
    const run = await savedQueriesCall(
      "POST",
      `/${savedId}/run`,
      down.token,
      {}
    );
    expect(run.status).toBe(503);
    expect(run.body.error).toBe("row_rule_unavailable");

    const panels = await postExport({
      token: down.token,
      body: {},
      path: `/v1/dashboards/${dashboardId}/run`,
    });
    expect(panels.status).toBe(200);
    const [line] = ndjsonLines(panels.text) as Array<{
      panel_id: string;
      rows?: unknown;
      error?: { error: string };
    }>;
    expect(line).toMatchObject({
      panel_id: panelId,
      error: { error: "row_rule_unavailable" },
    });
    expect(line).not.toHaveProperty("rows");
  });

  it("refuses with 409 when tereo finds too many users below", async () => {
    const res = await query(tooMany.token);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("row_rule_unavailable");
  });
});
