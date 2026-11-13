import type { PrincipalStatus } from "../grants/principals.js";
import type { GrantDetail } from "../utils/db/grants.js";

export const grantView = (
  row: GrantDetail,
  principalStatus: PrincipalStatus
) => ({
  id: row.id,
  principal_type: row.principalType,
  principal_id: row.principalId,
  principal_status: principalStatus,
  source: { id: row.table.source.id, slug: row.table.source.slug },
  table: {
    id: row.table.id,
    schema_name: row.table.schemaName,
    name: row.table.name,
    missing: row.table.missingSince !== null,
  },
  all_columns: row.allColumns,
  columns: row.columns.map(({ column }) => ({
    id: column.id,
    name: column.name,
    missing: column.missingSince !== null,
  })),
  created_by: row.createdBy,
  created_at: row.createdAt.toISOString(),
  updated_at: row.updatedAt.toISOString(),
});

export type GrantView = ReturnType<typeof grantView>;
