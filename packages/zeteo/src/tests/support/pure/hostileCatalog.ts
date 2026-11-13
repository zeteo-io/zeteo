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

// A catalogue whose every name is an attempt at breaking out of a quoted
// identifier. Kept apart from the shop: these names are the point of the
// tests that use it, and no ordinary test should depend on them.

export const HOSTILE = {
  schema: 'a"b',
  parent: "x; DROP TABLE y; --",
  child: "]",
  relation: "'",
  columns: {
    quote: 'a"b',
    bracket: "]",
    apostrophe: "'",
    drop: "x; DROP TABLE y; --",
    backslash: "back\\slash\\",
    placeholder: "$1",
    // the longest a path segment may be
    long: "c".repeat(128),
  },
  /** A schema and a table whose names hold dots: `dot.ted`.`ta.ble`. */
  dotted: { schema: "dot.ted", table: "ta.ble" },
  longTable: "L".repeat(200),
};

const SOURCE = {
  id: "src",
  slug: "hostile",
  name: "Hostile",
  type: "postgres",
  timeoutMs: 30_000,
  rowCap: 50_000,
} as Source;

const table = (id: string, name: string, schemaName: string = HOSTILE.schema) =>
  ({
    id,
    sourceId: SOURCE.id,
    schemaName,
    name,
    kind: "table",
    description: null,
    missingSince: null,
  }) as SourceTable;

const column = (
  tableId: string,
  name: string,
  type: SourceColumn["type"],
  position: number
) =>
  ({
    id: `${tableId}.${name}`,
    tableId,
    name,
    type,
    nativeType: type,
    nullable: true,
    position,
    isPrimaryKey: false,
    description: null,
    missingSince: null,
  }) as SourceColumn;

export const hostileCatalog = (): VisibleCatalog => {
  const { columns: c } = HOSTILE;
  const tables = [
    table("dotted", HOSTILE.dotted.table, HOSTILE.dotted.schema),
    table("long", HOSTILE.longTable),
    table("parent", HOSTILE.parent),
    table("child", HOSTILE.child),
  ];
  const columns = [
    column("parent", c.quote, "text", 1),
    column("parent", c.bracket, "number", 2),
    column("parent", c.apostrophe, "text", 3),
    column("parent", c.drop, "timestamp", 4),
    column("parent", c.backslash, "text", 5),
    column("parent", c.placeholder, "text", 6),
    column("parent", c.long, "text", 7),
    column("dotted", c.quote, "text", 1),
    column("long", c.quote, "text", 1),
    column("child", c.quote, "text", 1),
    column("child", c.bracket, "number", 2),
  ];
  const relations = [
    {
      id: "parent.rel",
      sourceId: SOURCE.id,
      name: HOSTILE.relation,
      fromTableId: "parent",
      fromColumns: [c.bracket],
      toTableId: "child",
      toColumns: [c.bracket],
      toMany: false,
      missingSince: null,
    } as Relation,
  ];
  const access: Access = {
    sourceIds: new Set([SOURCE.id]),
    allows: () => true,
    tableAccess: () => "all",
  };
  return buildVisibleCatalog(SOURCE, tables, columns, relations, access);
};
