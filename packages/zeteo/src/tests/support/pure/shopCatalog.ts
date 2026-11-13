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

// A shop: customers, orders, order_lines, accounts and ledger (Postgres's
// uuid, money, an enum and domains over them) in schema `shop`, plus
// `billing.accounts`, so the bare name `accounts` is ambiguous while both are
// visible. Ids are readable: a table's id is its key below, a column's is
// `<table key>.<column>`, a relation's is `<from table key>.<name>`.

type ColumnSpec = [name: string, type: ColumnType, nativeType: string];

const TABLES: Record<
  string,
  { schemaName: string; name: string; columns: ColumnSpec[] }
> = {
  customers: {
    schemaName: "shop",
    name: "customers",
    columns: [
      ["id", "number", "integer"],
      ["name", "text", "text"],
      ["email", "text", "text"],
      ["region", "text", "text"],
      ["account_id", "number", "integer"],
      ["vip", "boolean", "boolean"],
      ["prefs", "json", "jsonb"],
      ["photo", "other", "bytea"],
      ["created_at", "timestamp", "timestamp with time zone"],
    ],
  },
  orders: {
    schemaName: "shop",
    name: "orders",
    columns: [
      ["id", "number", "bigint"],
      ["customer_id", "number", "integer"],
      ["status", "text", "text"],
      ["total", "number", "numeric(12,2)"],
      ["ordered_on", "date", "date"],
      ["created_at", "timestamp", "timestamp with time zone"],
      ["notes", "text", "text"],
    ],
  },
  order_lines: {
    schemaName: "shop",
    name: "order_lines",
    columns: [
      ["id", "number", "bigint"],
      ["order_id", "number", "bigint"],
      ["sku", "text", "text"],
      ["quantity", "number", "integer"],
      ["price", "number", "numeric(12,2)"],
    ],
  },
  accounts: {
    schemaName: "shop",
    name: "accounts",
    columns: [
      ["id", "number", "integer"],
      ["name", "text", "text"],
      ["plan", "text", "text"],
    ],
  },
  ledger: {
    schemaName: "shop",
    name: "ledger",
    columns: [
      ["id", "number", "integer"],
      ["ref", "text", "uuid"],
      ["amount", "number", "money"],
      ["mood", "text", "shop.mood (enum)"],
      ["feeling", "text", "shop.feeling (domain over shop.mood (enum))"],
      ["price", "number", "shop.price (domain over money)"],
      ["token", "text", "shop.token (domain over uuid)"],
    ],
  },
  billing_accounts: {
    schemaName: "billing",
    name: "accounts",
    columns: [
      ["id", "number", "integer"],
      ["balance", "number", "numeric(12,2)"],
    ],
  },
};

const RELATIONS: Array<
  [
    from: string,
    name: string,
    fromCol: string,
    to: string,
    toCol: string,
    toMany: boolean,
  ]
> = [
  ["orders", "customer", "customer_id", "customers", "id", false],
  ["orders", "lines", "id", "order_lines", "order_id", true],
  ["customers", "account", "account_id", "accounts", "id", false],
];

export interface ShopOptions {
  /** Table keys or column ids the caller has no grant on. */
  hidden?: string[];
  /** Table keys, column ids or relation ids the source does not have at all. */
  absent?: string[];
  /** Table keys, column ids or relation ids the last refresh did not find. */
  missing?: string[];
  /**
   * Names each column `<table key>_<column>`, so no two columns share a name
   * and a name found in text is one column's. Ids, `hidden`, `absent` and
   * `missing` keep the plain names.
   */
  uniqueNames?: boolean;
  /** Whose type names `nativeType` holds; Postgres's unless SQL Server's are asked for. */
  engine?: "postgres" | "mssql";
}

/** The SQL Server type an Azure SQL source would report for each Postgres one above. */
const MSSQL_NATIVE: Record<string, string> = {
  integer: "int",
  bigint: "bigint",
  text: "nvarchar(200)",
  "numeric(12,2)": "decimal(12,2)",
  boolean: "bit",
  date: "date",
  jsonb: "nvarchar(max)",
  bytea: "varbinary(max)",
  "timestamp with time zone": "datetimeoffset(7)",
  uuid: "uniqueidentifier",
  money: "money",
  "shop.mood (enum)": "nvarchar(200)",
  "shop.feeling (domain over shop.mood (enum))": "nvarchar(200)",
  "shop.price (domain over money)": "money",
  "shop.token (domain over uuid)": "uniqueidentifier",
};

const SOURCE = {
  id: "src",
  slug: "shop",
  name: "Shop",
  type: "postgres",
  timeoutMs: 30_000,
  rowCap: 50_000,
} as Source;

/**
 * The shop as a caller sees it, built by the real `buildVisibleCatalog`: a
 * hidden key column hides its relation, exactly as in production.
 */
export const shopCatalog = (options: ShopOptions = {}): VisibleCatalog => {
  const hidden = new Set(options.hidden);
  const absent = new Set(options.absent);
  const missing = new Set(options.missing);
  const since = (id: string) => (missing.has(id) ? new Date(0) : null);
  const columnName = (key: string, name: string) =>
    options.uniqueNames ? `${key}_${name}` : name;

  const tables: SourceTable[] = [];
  const columns: SourceColumn[] = [];
  for (const [key, spec] of Object.entries(TABLES)) {
    if (absent.has(key)) continue;
    tables.push({
      id: key,
      sourceId: SOURCE.id,
      schemaName: spec.schemaName,
      name: spec.name,
      kind: "table",
      description: null,
      missingSince: since(key),
    } as SourceTable);
    spec.columns.forEach(([name, type, nativeType], i) => {
      const id = `${key}.${name}`;
      if (absent.has(id)) return;
      columns.push({
        id,
        tableId: key,
        name: columnName(key, name),
        type,
        nativeType:
          options.engine === "mssql" ? MSSQL_NATIVE[nativeType]! : nativeType,
        nullable: true,
        position: i + 1,
        isPrimaryKey: name === "id",
        description: null,
        missingSince: since(id),
      } as SourceColumn);
    });
  }

  const relations: Relation[] = RELATIONS.filter(
    ([from, name, , to]) =>
      !absent.has(`${from}.${name}`) && !absent.has(from) && !absent.has(to)
  ).map(
    ([from, name, fromCol, to, toCol, toMany]) =>
      ({
        id: `${from}.${name}`,
        sourceId: SOURCE.id,
        name,
        fromTableId: from,
        fromColumns: [columnName(from, fromCol)],
        toTableId: to,
        toColumns: [columnName(to, toCol)],
        toMany,
        missingSince: since(`${from}.${name}`),
      }) as Relation
  );

  const access: Access = {
    sourceIds: new Set([SOURCE.id]),
    allows: (tableId, columnId) =>
      !hidden.has(tableId) && !hidden.has(columnId),
    tableAccess: () => "all",
  };
  return buildVisibleCatalog(SOURCE, tables, columns, relations, access);
};
