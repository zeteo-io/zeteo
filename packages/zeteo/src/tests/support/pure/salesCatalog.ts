import type { ColumnType } from "../../../adapters/types.js";
import type { Access } from "../../../grants/access.js";
import type {
  Relation,
  Source,
  SourceColumn,
  SourceTable,
} from "../../../../prisma/generated/client/index.js";
import {
  buildVisibleCatalog,
  type VisibleCatalog,
} from "../../../grants/visibleCatalog.js";

// The example source `sales-db` of docs/querying.md and the MCP instructions,
// with the relation names the discovery rules give: a single foreign key is
// named after its target table, the reverse side after the table holding it.

const TABLES: Record<string, Array<[string, ColumnType]>> = {
  customers: [
    ["id", "number"],
    ["name", "text"],
    ["first_name", "text"],
    ["last_name", "text"],
    ["email", "text"],
    ["region", "text"],
  ],
  orders: [
    ["id", "number"],
    ["customer_id", "number"],
    ["status", "text"],
    ["total", "number"],
    ["created_at", "timestamp"],
  ],
  order_lines: [
    ["id", "number"],
    ["order_id", "number"],
    ["product_id", "number"],
    ["unit_price", "number"],
    ["quantity", "number"],
    ["discount", "number"],
    ["unit_cost", "number"],
  ],
  products: [
    ["id", "number"],
    ["name", "text"],
    ["category", "text"],
  ],
};

const RELATIONS: Array<[string, string, string, string, string, boolean]> = [
  ["orders", "customers", "customer_id", "customers", "id", false],
  ["customers", "orders", "id", "orders", "customer_id", true],
  ["order_lines", "orders", "order_id", "orders", "id", false],
  ["orders", "order_lines", "id", "order_lines", "order_id", true],
  ["order_lines", "products", "product_id", "products", "id", false],
  ["products", "order_lines", "id", "order_lines", "product_id", true],
];

const SOURCE = {
  id: "src",
  slug: "sales-db",
  name: "Sales",
  type: "postgres",
  timeoutMs: 30_000,
  rowCap: 50_000,
  maxJoins: 4,
} as Source;

export const salesCatalog = (): VisibleCatalog => {
  const tables: SourceTable[] = [];
  const columns: SourceColumn[] = [];
  for (const [key, specs] of Object.entries(TABLES)) {
    tables.push({
      id: key,
      sourceId: SOURCE.id,
      schemaName: "sales",
      name: key,
      kind: "table",
      description: null,
      missingSince: null,
    } as SourceTable);
    specs.forEach(([name, type], i) =>
      columns.push({
        id: `${key}.${name}`,
        tableId: key,
        name,
        type,
        nativeType: type === "number" ? "numeric(12,2)" : "text",
        nullable: true,
        position: i + 1,
        isPrimaryKey: name === "id",
        description: null,
        missingSince: null,
      } as SourceColumn)
    );
  }
  const relations = RELATIONS.map(
    ([from, name, fromCol, to, toCol, toMany]) =>
      ({
        id: `${from}.${name}`,
        sourceId: SOURCE.id,
        name,
        fromTableId: from,
        fromColumns: [fromCol],
        toTableId: to,
        toColumns: [toCol],
        toMany,
        missingSince: null,
      }) as Relation
  );
  const access: Access = {
    sourceIds: new Set([SOURCE.id]),
    allows: () => true,
    tableAccess: () => "all",
  };
  return buildVisibleCatalog(SOURCE, tables, columns, relations, access);
};
