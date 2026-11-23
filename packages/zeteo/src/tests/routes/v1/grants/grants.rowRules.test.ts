// @module-tag int
// @module-tag platform
import { auditRows, removeSources } from "../../../support/sources.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { giveOwnerGrant } from "../../../../uploads/service.js";
import { startV1Routes } from "../../../support/v1App.js";
import { prisma } from "../../../../utils/db/prisma.js";
import { tokenFor } from "../../../support/tokens.js";
import { fetchJson } from "../../../support/http.js";
import { randomUUID } from "crypto";
import {
  DATA_READ,
  UPLOADS_WRITE,
} from "../../../../definitions/tereoDeclaration.js";
import {
  removeUploadSources,
  seedUploadSource,
} from "../../../support/uploads.js";
import {
  grantsWriteToken,
  registerSource,
  tableOf,
} from "../../../support/grants.js";

const RULE = {
  and: [
    { status: { in: ["paid", "shipped"] } },
    { created_at: { gte: { relative: { unit: "day", offset: -90 } } } },
  ],
};

describe("/v1/grants row access", () => {
  let app: Awaited<ReturnType<typeof startV1Routes>>;
  let sourceId: string;
  let orders: Awaited<ReturnType<typeof tableOf>>;
  let customers: Awaited<ReturnType<typeof tableOf>>;
  const keyName = `rep_${randomUUID().slice(0, 8)}`;
  let keyId: string;

  const call = (
    method: string,
    path: string,
    body?: unknown,
    token = grantsWriteToken()
  ) => fetchJson(method, `${app.url}/v1/grants${path}`, token, body);

  const create = (
    overrides: Record<string, unknown> = {},
    table: { id: string } = orders,
    token = grantsWriteToken()
  ) =>
    call(
      "POST",
      "",
      {
        principal_type: "user",
        principal_id: randomUUID(),
        table_id: table.id,
        all_columns: true,
        ...overrides,
      },
      token
    );

  beforeAll(async () => {
    app = await startV1Routes();
    sourceId = await registerSource(app.url);
    orders = await tableOf(sourceId, "orders");
    customers = await tableOf(sourceId, "customers");
    keyId = (
      await prisma.identityKey.create({
        data: { name: keyName, label: "Rep", createdBy: randomUUID() },
      })
    ).id;
  });
  afterAll(async () => {
    await removeSources([sourceId]);
    await prisma.identityKey.deleteMany({ where: { id: keyId } });
    await app.close();
  });

  it("defaults to unlimited_default with no rule", async () => {
    const res = await create();
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      row_access: "unlimited_default",
      row_rule: null,
      row_rule_description: null,
      row_rule_problems: [],
    });
  });

  it("creates a rule grant and answers with the rule by name", async () => {
    const res = await create({
      row_access: "rule",
      row_rule: RULE,
      row_rule_description: "Recent paid orders",
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      row_access: "rule",
      row_rule: RULE,
      row_rule_description: "Recent paid orders",
      row_rule_problems: [],
    });
    const got = await call("GET", `/${res.body.id}`);
    expect(got.body.row_rule).toEqual(RULE);
  });

  it("stores the rule by column id and identity key id", async () => {
    const rule = {
      and: [
        { status: { eq: "paid" } },
        { notes: { in: { identity: keyName } } },
      ],
    };
    const res = await create({ row_access: "rule", row_rule: rule });
    expect(res.status).toBe(201);
    expect(res.body.row_rule).toEqual(rule);
    const row = await prisma.grant.findUniqueOrThrow({
      where: { id: res.body.id },
    });
    const columns = await prisma.sourceColumn.findMany({
      where: { tableId: orders.id },
    });
    const idOf = (name: string) => columns.find((c) => c.name === name)!.id;
    expect(row.rowRule).toEqual({
      and: [
        { [idOf("status")]: { eq: "paid" } },
        { [idOf("notes")]: { in: { identity: keyId } } },
      ],
    });
    expect(row.identityKeyIds).toEqual([keyId]);
  });

  it.each([
    [
      "a column of another table",
      { name: { eq: "Acme" } },
      ["row_rule", "name"],
    ],
    [
      "a relation path",
      { "customer.name": { eq: "Acme" } },
      ["row_rule", "customer.name"],
    ],
    [
      "an unknown identity key",
      { and: [{ status: { in: { identity: "no_such_key_xyz" } } }] },
      ["row_rule", "and", 0, "status", "in", "identity"],
    ],
    [
      "an operator that does not suit the type",
      { total: { contains: "1" } },
      ["row_rule", "total", "contains"],
    ],
    [
      "a literal of the wrong type",
      { not: { created_at: { lt: "yesterday" } } },
      ["row_rule", "not", "created_at", "lt"],
    ],
    [
      "a measure",
      { total: { gt: { measure: "revenue" } } },
      ["row_rule", "total", "gt"],
    ],
    [
      "a bad column nested inside and and or",
      {
        and: [
          { status: { eq: "paid" } },
          { or: [{ status: { eq: "paid" } }, { total: { contains: "1" } }] },
        ],
      },
      ["row_rule", "and", 1, "or", 1, "total", "contains"],
    ],
  ])("refuses %s with invalid_row_rule at its path", async (_n, rule, path) => {
    const res = await create({ row_access: "rule", row_rule: rule });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_row_rule");
    expect(res.body.path).toEqual(path);
  });

  it.each([
    [
      "a column missing from the source",
      { missingSince: new Date() },
      { notes: { eq: "x" } },
      "is missing from the source",
    ],
    [
      "a column of a type that cannot be queried",
      { type: "other" as const },
      { notes: { eq: "x" } },
      "cannot be queried",
    ],
    [
      "an identity value on a boolean column",
      { type: "boolean" as const },
      { notes: { eq: { identity: keyName } } },
      "cannot be compared",
    ],
    [
      "an identity value on a json column (no operator takes one)",
      { type: "json" as const },
      { notes: { eq: { identity: keyName } } },
      "does not apply",
    ],
  ])("refuses %s", async (_n, change, rule, message) => {
    const column = await prisma.sourceColumn.findFirstOrThrow({
      where: { tableId: orders.id, name: "notes" },
    });
    await prisma.sourceColumn.update({
      where: { id: column.id },
      data: change,
    });
    try {
      const res = await create({ row_access: "rule", row_rule: rule });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("invalid_row_rule");
      expect(res.body.path.slice(0, 2)).toEqual(["row_rule", "notes"]);
      expect(res.body.error_description).toContain(message);
    } finally {
      await prisma.sourceColumn.update({
        where: { id: column.id },
        data: {
          missingSince: column.missingSince,
          type: column.type,
        },
      });
    }
  });

  it("refuses below: true as not available yet", async () => {
    const res = await create({
      row_access: "rule",
      row_rule: { notes: { in: { identity: keyName, below: true } } },
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_row_rule");
    expect(res.body.error_description).toMatch(/not available yet/);
    expect(res.body.path).toEqual(["row_rule", "notes", "in"]);
  });

  it.each([
    ["rule without row_rule", { row_access: "rule" }],
    ["row_rule with unlimited_default", { row_rule: RULE }],
    ["row_rule with all", { row_access: "all", row_rule: RULE }],
    [
      "a description without a rule",
      { row_access: "all", row_rule_description: "x" },
    ],
    [
      "a description over 200 characters",
      {
        row_access: "rule",
        row_rule: RULE,
        row_rule_description: "x".repeat(201),
      },
    ],
  ])("refuses %s with 400", async (_n, body) => {
    const res = await create(body);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_request");
  });

  it("takes a null rule and a null or blank description as not given", async () => {
    for (const description of [null, "", "  "]) {
      const res = await create({
        row_access: "all",
        row_rule: null,
        row_rule_description: description,
      });
      expect(res.status, String(description)).toBe(201);
      expect(res.body.row_rule_description).toBeNull();
    }
  });

  it("replaces columns and rows together; rule to all clears the rule", async () => {
    const made = await create({
      row_access: "rule",
      row_rule: RULE,
      row_rule_description: "Recent",
    });
    expect(made.status).toBe(201);
    const res = await call("PUT", `/${made.body.id}`, {
      all_columns: true,
      row_access: "all",
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      row_access: "all",
      row_rule: null,
      row_rule_description: null,
    });
    const row = await prisma.grant.findUniqueOrThrow({
      where: { id: made.body.id },
    });
    expect(row.rowRule).toBeNull();
    expect(row.identityKeyIds).toEqual([]);
  });

  it("requires row_access on a replace, leaving the rule as it was", async () => {
    const made = await create({ row_access: "rule", row_rule: RULE });
    expect(made.status).toBe(201);
    const res = await call("PUT", `/${made.body.id}`, { all_columns: true });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_request");
    const got = await call("GET", `/${made.body.id}`);
    expect(got.body).toMatchObject({ row_access: "rule", row_rule: RULE });
  });

  it("validates a replaced rule against the grant's own table", async () => {
    const made = await create({}, customers);
    const res = await call("PUT", `/${made.body.id}`, {
      all_columns: true,
      row_access: "rule",
      row_rule: { status: { eq: "paid" } },
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_row_rule");
    expect(res.body.path).toEqual(["row_rule", "status"]);
  });

  it("reports a rule's missing column as a problem", async () => {
    const made = await create({
      row_access: "rule",
      row_rule: { external_ref: { isNull: false } },
    });
    expect(made.status).toBe(201);
    const column = await prisma.sourceColumn.findFirstOrThrow({
      where: { tableId: orders.id, name: "external_ref" },
    });
    await prisma.sourceColumn.update({
      where: { id: column.id },
      data: { missingSince: new Date() },
    });
    try {
      const got = await call("GET", `/${made.body.id}`);
      expect(got.body.row_rule).toEqual({ external_ref: { isNull: false } });
      expect(got.body.row_rule_problems).toEqual([
        "column_missing:external_ref",
      ]);
    } finally {
      await prisma.sourceColumn.update({
        where: { id: column.id },
        data: { missingSince: null },
      });
    }
  });

  it("puts row access in the audit metadata", async () => {
    const made = await create({
      row_access: "rule",
      row_rule: { status: { eq: "paid" } },
      row_rule_description: "Paid",
    });
    const statusId = (
      await prisma.sourceColumn.findFirstOrThrow({
        where: { tableId: orders.id, name: "status" },
      })
    ).id;
    const [entry] = await auditRows(made.body.id);
    expect(entry!.payload).toMatchObject({
      metadata: {
        row_access: "rule",
        row_rule: { [statusId]: { eq: "paid" } },
        row_rule_description: "Paid",
      },
    });
  });

  describe("upload sources", () => {
    const ownerId = randomUUID();
    const owner = tokenFor({
      userId: ownerId,
      permissions: [DATA_READ, UPLOADS_WRITE],
    });
    let upload: Awaited<ReturnType<typeof seedUploadSource>>;

    beforeAll(async () => {
      upload = await seedUploadSource({
        ownerId,
        tables: [
          {
            name: "deals",
            columns: [
              { name: "id", type: "number" },
              { name: "region", type: "text" },
            ],
            rows: [["1", "West"]],
          },
        ],
      });
    });
    afterAll(async () => {
      await removeUploadSources([upload.id]);
    });

    it("lets the owner create a rule grant on their own source", async () => {
      const res = await create(
        {
          row_access: "rule",
          row_rule: { region: { in: { identity: keyName } } },
        },
        upload.tables.deals!,
        owner
      );
      expect(res.status).toBe(201);
      expect(res.body.row_access).toBe("rule");
    });

    it("drops a grant's rule when it becomes an owner grant", async () => {
      const userId = randomUUID();
      const made = await create(
        {
          principal_id: userId,
          row_access: "rule",
          row_rule: { region: { in: { identity: keyName } } },
          row_rule_description: "Own region",
        },
        upload.tables.deals!
      );
      expect(made.status).toBe(201);
      await prisma.$transaction((tx) =>
        giveOwnerGrant(tx, upload.tables.deals!.id, userId, userId)
      );
      const row = await prisma.grant.findUniqueOrThrow({
        where: { id: made.body.id },
      });
      expect(row).toMatchObject({
        ownerGrant: true,
        rowAccess: "unlimited_default",
        rowRule: null,
        rowRuleDescription: null,
        identityKeyIds: [],
      });
      await prisma.grant.update({
        where: { id: row.id },
        data: { ownerGrant: false },
      });
    });

    it("refuses any row access but the default on an owner grant", async () => {
      const ownerGrant = await prisma.grant.findFirstOrThrow({
        where: { tableId: upload.tables.deals!.id, ownerGrant: true },
      });
      for (const rows of [
        { row_access: "rule", row_rule: { region: { eq: "West" } } },
        { row_access: "all" },
      ]) {
        const res = await call(
          "PUT",
          `/${ownerGrant.id}`,
          { all_columns: true, ...rows },
          owner
        );
        expect(res.status, rows.row_access).toBe(409);
        expect(res.body.error).toBe("owner_grant_locked");
      }
      const same = await call(
        "PUT",
        `/${ownerGrant.id}`,
        { all_columns: true, row_access: "unlimited_default" },
        owner
      );
      expect(same.status).toBe(200);
    });
  });
});
