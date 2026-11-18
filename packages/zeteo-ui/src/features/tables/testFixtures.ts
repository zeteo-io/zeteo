import type { Column, Table, TableDetail } from "./api/types";

export const ORDERS_ID = "a1111111-1c7a-4a53-9d0e-6a3b1f2c4d01";
export const CUSTOMERS_ID = "a2222222-1c7a-4a53-9d0e-6a3b1f2c4d02";
export const GONE_ID = "a3333333-1c7a-4a53-9d0e-6a3b1f2c4d03";

export const makeTable = (over: Partial<Table> = {}): Table => ({
  id: ORDERS_ID,
  source_id: "5f0c8f0e-1c7a-4a53-9d0e-6a3b1f2c4d55",
  schema_name: "public",
  name: "orders",
  kind: "table",
  description: "Customer orders",
  last_seen_at: "2026-11-01T10:00:00.000Z",
  missing_since: null,
  row_count: null,
  last_loaded_at: null,
  ...over,
});

export const makeColumn = (over: Partial<Column> = {}): Column => ({
  id: "c0000000-1c7a-4a53-9d0e-6a3b1f2c4d01",
  name: "id",
  type: "integer",
  native_type: "integer",
  nullable: false,
  position: 1,
  is_primary_key: true,
  description: null,
  missing_since: null,
  original_name: null,
  ...over,
});

export const makeTableDetail = (
  over: Partial<TableDetail> = {}
): TableDetail => ({
  ...makeTable(),
  columns: [
    makeColumn(),
    makeColumn({
      id: "c0000000-1c7a-4a53-9d0e-6a3b1f2c4d02",
      name: "customer_id",
      position: 2,
      is_primary_key: false,
      description: "Who ordered",
    }),
    makeColumn({
      id: "c0000000-1c7a-4a53-9d0e-6a3b1f2c4d03",
      name: "note",
      type: "text",
      native_type: "text",
      nullable: true,
      position: 3,
      is_primary_key: false,
    }),
  ],
  relations: [],
  ...over,
});
