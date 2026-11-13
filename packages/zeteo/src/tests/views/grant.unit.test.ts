// @module-tag unit
// @module-tag platform
import { grantView } from "../../views/grant.js";
import { describe, expect, it } from "vitest";

type GrantDetail = Parameters<typeof grantView>[0];

const at = new Date("2026-11-12T00:00:00.000Z");

const detail = (overrides: Partial<GrantDetail> = {}): GrantDetail =>
  ({
    id: "0198f7a2-0000-7000-8000-000000000001",
    principalType: "group",
    principalId: "0198f7a2-0000-7000-8000-000000000002",
    tableId: "0198f7a2-0000-7000-8000-000000000003",
    allColumns: false,
    rowFilter: null,
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
    expect(grantView(detail(), "unknown")).toEqual({
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
      created_by: "0198f7a2-0000-7000-8000-000000000004",
      created_at: "2026-11-12T00:00:00.000Z",
      updated_at: "2026-11-12T00:00:00.000Z",
    });
  });
});
