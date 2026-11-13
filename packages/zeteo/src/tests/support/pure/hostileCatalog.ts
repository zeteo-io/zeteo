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
  },
};

const SOURCE = {
  id: "src",
  slug: "hostile",
  name: "Hostile",
  type: "postgres",
  timeoutMs: 30_000,
  rowCap: 50_000,
} as Source;

const table = (id: string, name: string) =>
  ({
    id,
    sourceId: SOURCE.id,
    schemaName: HOSTILE.schema,
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
    table("parent", HOSTILE.parent),
    table("child", HOSTILE.child),
  ];
  const columns = [
    column("parent", c.quote, "text", 1),
    column("parent", c.bracket, "number", 2),
    column("parent", c.apostrophe, "text", 3),
    column("parent", c.drop, "timestamp", 4),
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
