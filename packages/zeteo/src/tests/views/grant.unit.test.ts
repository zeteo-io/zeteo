// @module-tag unit
// @module-tag platform
import { grantView } from "../../views/grant.js";
import { describe, expect, it } from "vitest";

type GrantDetail = Parameters<typeof grantView>[0];

const noNames = { columns: new Map(), keys: new Map() };

const at = new Date("2026-11-12T00:00:00.000Z");

const detail = (overrides: Partial<GrantDetail> = {}): GrantDetail =>
  ({
    id: "0198f7a2-0000-7000-8000-000000000001",
    principalType: "group",
    principalId: "0198f7a2-0000-7000-8000-000000000002",
    tableId: "0198f7a2-0000-7000-8000-000000000003",
    allColumns: false,
    rowAccess: "unlimited_default",
    rowRule: null,
    rowRuleDescription: null,
    identityKeyIds: [],
    createdBy: "0198f7a2-0000-7000-8000-000000000004",
    createdAt: at,
    updatedAt: at,
    table: {
      id: "0198f7a2-0000-7000-8000-000000000003",
      schemaName: "sales",
      name: "orders",
      missingSince: null,
      source: { id: "0198f7a2-0000-7000-8000-000000000005", slug: "sales-db" },
    },
    columns: [
      {
        grantId: "0198f7a2-0000-7000-8000-000000000001",
        columnId: "0198f7a2-0000-7000-8000-000000000006",
        column: {
          id: "0198f7a2-0000-7000-8000-000000000006",
          name: "total",
          missingSince: at,
        },
      },
    ],
    ...overrides,
  }) as unknown as GrantDetail;

describe("grantView", () => {
  it("shows the grant, its table and source, and flags a missing column", () => {
    expect(grantView(detail(), "unknown", noNames)).toEqual({
      id: "0198f7a2-0000-7000-8000-000000000001",
      principal_type: "group",
      principal_id: "0198f7a2-0000-7000-8000-000000000002",
      principal_status: "unknown",
      source: { id: "0198f7a2-0000-7000-8000-000000000005", slug: "sales-db" },
      table: {
        id: "0198f7a2-0000-7000-8000-000000000003",
        schema_name: "sales",
        name: "orders",
        missing: false,
      },
      all_columns: false,
      columns: [
        {
          id: "0198f7a2-0000-7000-8000-000000000006",
          name: "total",
          missing: true,
        },
      ],
      row_access: "unlimited_default",
      row_rule: null,
      row_rule_description: null,
      row_rule_problems: [],
      created_by: "0198f7a2-0000-7000-8000-000000000004",
      created_at: "2026-11-12T00:00:00.000Z",
      updated_at: "2026-11-12T00:00:00.000Z",
    });
  });

  it("shows a rule by name and flags what keeps it from applying", () => {
    const column = "0198f7a2-0000-7000-8000-000000000007";
    const gone = "0198f7a2-0000-7000-8000-000000000008";
    const key = "0198f7a2-0000-7000-8000-000000000009";
    const view = grantView(
      detail({
        rowAccess: "rule",
        rowRule: {
          and: [{ [column]: { in: { identity: key } } }, { [gone]: { eq: 1 } }],
        },
        rowRuleDescription: "Own rows",
      }),
      "active",
      {
        columns: new Map([[column, { name: "rep", missing: true }]]),
        keys: new Map([[key, { name: "rep_id" }]]),
      }
    );
    expect(view).toMatchObject({
      row_access: "rule",
      row_rule: {
        and: [{ rep: { in: { identity: "rep_id" } } }, { [gone]: { eq: 1 } }],
      },
      row_rule_description: "Own rows",
      row_rule_problems: ["column_missing:rep", `column_unknown:${gone}`],
    });
  });
});
