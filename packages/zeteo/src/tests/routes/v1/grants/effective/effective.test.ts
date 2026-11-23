// @module-tag int
// @module-tag platform
import { UPLOADS_WRITE } from "../../../../../definitions/tereoDeclaration.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { saveMergedTable } from "../../../../../uploads/merged.js";
import type { Caller } from "../../../../../middleware/auth.js";
import { removeSources } from "../../../../support/sources.js";
import { startV1Routes } from "../../../../support/v1App.js";
import { prisma } from "../../../../../utils/db/prisma.js";
import { tokenFor } from "../../../../support/tokens.js";
import { fetchJson } from "../../../../support/http.js";
import { randomUUID } from "crypto";
import {
  clearTestGroups,
  setTestGroups,
} from "../../../../support/principals.js";
import {
  clearTestReports,
  failTestReports,
  setTestReports,
} from "../../../../support/hierarchy.js";
import {
  removeUploadSources,
  seedUploadSource,
} from "../../../../support/uploads.js";
import {
  columnsOf,
  grantsReadToken,
  grantsWriteToken,
  registerSource,
  tableOf,
} from "../../../../support/grants.js";

describe("GET /v1/grants/effective", () => {
  let app: Awaited<ReturnType<typeof startV1Routes>>;
  let sourceId: string;
  let orders: Awaited<ReturnType<typeof tableOf>>;
  let columnId: (name: string) => string;
  const keyName = `eff_${randomUUID().slice(0, 8)}`;
  let keyId: string;
  const uploadIds: string[] = [];
  const grouped: string[] = [];
  const reporting: string[] = [];

  const effective = (
    userId: string,
    tableId = orders.id,
    token = grantsReadToken()
  ) =>
    fetchJson(
      "GET",
      `${app.url}/v1/grants/effective?user_id=${userId}&table_id=${tableId}`,
      token
    );

  const grant = async (body: Record<string, unknown>) => {
    const res = await fetchJson(
      "POST",
      `${app.url}/v1/grants`,
      grantsWriteToken(),
      {
        principal_type: "user",
        principal_id: randomUUID(),
        table_id: orders.id,
        all_columns: true,
        ...body,
      }
    );
    expect(res.status).toBe(201);
    return res.body as { id: string; principal_id: string };
  };

  beforeAll(async () => {
    app = await startV1Routes();
    sourceId = await registerSource(app.url);
    orders = await tableOf(sourceId, "orders");
    const columns = await columnsOf(orders.id);
    columnId = (name) => columns.find((c) => c.name === name)!.id;
    keyId = (
      await prisma.identityKey.create({
        data: { name: keyName, label: "Rep", createdBy: randomUUID() },
      })
    ).id;
  });
  afterAll(async () => {
    for (const userId of grouped) await clearTestGroups(userId);
    for (const userId of reporting) await clearTestReports(userId);
    await removeSources([sourceId]);
    await removeUploadSources(uploadIds);
    await prisma.identityValue.deleteMany({ where: { keyId } });
    await prisma.identityKey.deleteMany({ where: { id: keyId } });
    await app.close();
  });

  it("gives the columns, the rows in words and the grant of a rule", async () => {
    const userId = randomUUID();
    const g = await grant({
      principal_id: userId,
      all_columns: false,
      column_ids: [columnId("id"), columnId("status")],
      row_access: "rule",
      row_rule: { status: { in: ["paid", "shipped"] } },
    });
    const res = await effective(userId);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      columns: ["id", "status"],
      rows: "limited",
      rule_summary: "status is one of paid, shipped",
      grants: [
        {
          grant_id: g.id,
          principal_type: "user",
          principal_id: userId,
          row_access: "rule",
        },
      ],
      warnings: [],
    });
  });

  it("describes a rule on a column the user is not granted, as the admin sees it", async () => {
    const userId = randomUUID();
    await grant({
      principal_id: userId,
      all_columns: false,
      column_ids: [columnId("id")],
      row_access: "rule",
      row_rule: { status: { eq: "paid" } },
    });
    const res = await effective(userId);
    expect(res.body).toMatchObject({
      columns: ["id"],
      rows: "limited",
      rule_summary: "status is paid",
    });
  });

  it("warns that a group's all-rows grant overrides the user's rule", async () => {
    const userId = randomUUID();
    const groupId = randomUUID();
    await setTestGroups(userId, [{ id: groupId, organizationId: null }]);
    grouped.push(userId);
    const own = await grant({
      principal_id: userId,
      row_access: "rule",
      row_rule: { status: { eq: "paid" } },
    });
    const group = await grant({
      principal_type: "group",
      principal_id: groupId,
      row_access: "all",
    });
    const res = await effective(userId);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      columns: "all",
      rows: "all",
      rule_summary: null,
      warnings: [{ code: "all_rows_overrides", grant_id: group.id }],
    });
    expect(
      (res.body.grants as { grant_id: string }[]).map((g) => g.grant_id).sort()
    ).toEqual([own.id, group.id].sort());
  });

  it("gives no rows and warns when the user has no value under a rule's key", async () => {
    const userId = randomUUID();
    await grant({
      principal_id: userId,
      row_access: "rule",
      row_rule: { notes: { in: { identity: keyName } } },
    });
    const res = await effective(userId);
    expect(res.body).toMatchObject({
      rows: "none",
      rule_summary: "notes is your Rep",
      warnings: [{ code: "missing_identity_value", key: keyName }],
    });
  });

  it("is limited, with no warning, once the user holds a value", async () => {
    const userId = randomUUID();
    await grant({
      principal_id: userId,
      row_access: "rule",
      row_rule: { notes: { in: { identity: keyName } } },
    });
    await prisma.identityValue.create({
      data: { keyId, userId, value: "R-1", createdBy: userId },
    });
    const res = await effective(userId);
    expect(res.body).toMatchObject({
      rows: "limited",
      rule_summary: "notes is your Rep",
      warnings: [],
    });
    expect(JSON.stringify(res.body)).not.toContain("R-1");
  });

  it("describes a below rule without naming anyone, limited by a report's value", async () => {
    const userId = randomUUID();
    const reportId = randomUUID();
    reporting.push(userId);
    await setTestReports(userId, [reportId]);
    await grant({
      principal_id: userId,
      row_access: "rule",
      row_rule: { notes: { in: { identity: keyName, below: true } } },
    });
    await prisma.identityValue.create({
      data: { keyId, userId: reportId, value: "R-below", createdBy: userId },
    });
    const res = await effective(userId);
    expect(res.body).toMatchObject({
      rows: "limited",
      rule_summary: "notes is your Rep or that of anyone who reports to you",
      warnings: [],
    });
    const text = JSON.stringify(res.body);
    expect(text).not.toContain(reportId);
    expect(text).not.toContain("R-below");
  });

  it("warns of a missing value when no one below holds one either", async () => {
    const userId = randomUUID();
    reporting.push(userId);
    await setTestReports(userId, [randomUUID()]);
    await grant({
      principal_id: userId,
      row_access: "rule",
      row_rule: { notes: { in: { identity: keyName, below: true } } },
    });
    const res = await effective(userId);
    expect(res.body).toMatchObject({
      rows: "none",
      warnings: [{ code: "missing_identity_value", key: keyName }],
    });
  });

  it("warns that a below rule cannot be applied when tereo cannot say who is below", async () => {
    const userId = randomUUID();
    reporting.push(userId);
    await failTestReports(userId, "unavailable");
    await grant({
      principal_id: userId,
      row_access: "rule",
      row_rule: { notes: { in: { identity: keyName, below: true } } },
    });
    const res = await effective(userId);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      rows: "none",
      rule_summary: "notes is your Rep or that of anyone who reports to you",
      // Whether anyone below holds a value is unknown: no missing value.
      warnings: [
        { code: "row_rule_unavailable", reason: "hierarchy_unavailable" },
      ],
    });
  });

  it("gives no rows and nothing else when no grant reaches the user", async () => {
    const res = await effective(randomUUID());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      columns: [],
      rows: "none",
      rule_summary: null,
      grants: [],
      warnings: [],
    });
  });

  it("warns that a rule cannot be applied when its column has gone missing", async () => {
    const userId = randomUUID();
    await grant({
      principal_id: userId,
      row_access: "rule",
      row_rule: { external_ref: { gt: 5 } },
    });
    await prisma.sourceColumn.update({
      where: { id: columnId("external_ref") },
      data: { missingSince: new Date() },
    });
    try {
      const res = await effective(userId);
      expect(res.body).toMatchObject({
        rows: "none",
        warnings: [{ code: "row_rule_unavailable", reason: "column_missing" }],
      });
    } finally {
      await prisma.sourceColumn.update({
        where: { id: columnId("external_ref") },
        data: { missingSince: null },
      });
    }
  });

  /** An upload source with tables east and west (sku x and y each), merged as both. */
  const mergedEastWest = async () => {
    const ownerId = randomUUID();
    const owner: Caller = {
      userId: ownerId,
      organizationId: null,
      permissions: [UPLOADS_WRITE],
      isServiceAccount: false,
    };
    const spec = (name: string) => ({
      name,
      columns: [{ name: "sku", type: "text" as const }],
      rows: [["x"], ["y"]],
    });
    const seeded = await seedUploadSource({
      ownerId,
      tables: [spec("east"), spec("west")],
    });
    uploadIds.push(seeded.id);
    const east = seeded.tables.east!;
    const west = seeded.tables.west!;
    await saveMergedTable(owner, seeded.id, {
      name: "both",
      label_column: "region",
      members: [
        { table_id: east.id, label: "East" },
        { table_id: west.id, label: "West" },
      ],
      columns: [{ name: "sku", from_name: "sku", include: true }],
    });
    const merged = await prisma.sourceTable.findFirstOrThrow({
      where: { sourceId: seeded.id, name: "both" },
      include: { columns: true },
    });
    const mergedSku = merged.columns.find((c) => c.name === "sku")!.id;
    return { ownerId, east, west, merged, mergedSku };
  };

  it("warns when a merged table shows every row but a member's rows are limited", async () => {
    const { ownerId, east, west, merged } = await mergedEastWest();
    const userId = randomUUID();
    await prisma.grant.createMany({
      data: [
        {
          principalType: "user",
          principalId: userId,
          tableId: merged.id,
          allColumns: true,
          createdBy: ownerId,
        },
        {
          principalType: "user",
          principalId: userId,
          tableId: east.id,
          allColumns: true,
          rowAccess: "rule",
          rowRule: { [east.columns.sku!]: { eq: "x" } },
          createdBy: ownerId,
        },
        {
          principalType: "user",
          principalId: userId,
          tableId: west.id,
          allColumns: true,
          createdBy: ownerId,
        },
      ],
    });
    const res = await effective(userId, merged.id);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      rows: "all",
      warnings: [
        { code: "merged_members_limited", member_table_ids: [east.id] },
      ],
    });
  });

  it("warns when a merged table's rule differs from a member's rule", async () => {
    const { ownerId, east, west, merged, mergedSku } = await mergedEastWest();
    const userId = randomUUID();
    await prisma.grant.createMany({
      data: [
        {
          principalType: "user",
          principalId: userId,
          tableId: merged.id,
          allColumns: true,
          rowAccess: "rule",
          rowRule: { [mergedSku]: { in: ["x", "y"] } },
          createdBy: ownerId,
        },
        {
          principalType: "user",
          principalId: userId,
          tableId: east.id,
          allColumns: true,
          rowAccess: "rule",
          rowRule: { [east.columns.sku!]: { eq: "x" } },
          createdBy: ownerId,
        },
        {
          principalType: "user",
          principalId: userId,
          tableId: west.id,
          allColumns: true,
          rowAccess: "rule",
          rowRule: { [west.columns.sku!]: { in: ["x", "y"] } },
          createdBy: ownerId,
        },
      ],
    });
    const res = await effective(userId, merged.id);
    expect(res.status).toBe(200);
    // West's rule is the merged table's, by column name: no warning for it.
    expect(res.body).toMatchObject({
      rows: "limited",
      warnings: [
        { code: "merged_members_limited", member_table_ids: [east.id] },
      ],
    });
  });

  it("does not warn when every member's rule is the merged table's", async () => {
    const { ownerId, east, west, merged, mergedSku } = await mergedEastWest();
    const userId = randomUUID();
    await prisma.grant.createMany({
      data: [merged.id, east.id, west.id].map((tableId) => ({
        principalType: "user" as const,
        principalId: userId,
        tableId,
        allColumns: true,
        rowAccess: "rule" as const,
        rowRule: {
          [tableId === merged.id
            ? mergedSku
            : tableId === east.id
              ? east.columns.sku!
              : west.columns.sku!]: { eq: "x" },
        },
        createdBy: ownerId,
      })),
    });
    const res = await effective(userId, merged.id);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ rows: "limited", warnings: [] });
  });

  it("is 404 for a table that does not exist", async () => {
    const res = await effective(randomUUID(), randomUUID());
    expect(res.status).toBe(404);
  });

  it("is 400 without a user", async () => {
    const res = await fetchJson(
      "GET",
      `${app.url}/v1/grants/effective?table_id=${orders.id}`,
      grantsReadToken()
    );
    expect(res.status).toBe(400);
  });

  it("is 403 without zeteo.grants.read", async () => {
    const res = await effective(
      randomUUID(),
      orders.id,
      tokenFor({ permissions: [UPLOADS_WRITE] })
    );
    expect(res.status).toBe(403);
  });
});
