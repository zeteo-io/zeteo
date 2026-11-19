import type { ColumnType, SourceType } from "../adapters/types.js";
import type { Calendar } from "../calendar/calendar.js";
import { loadCalendar } from "../calendar/service.js";
import { typeOf } from "../sources/types.js";
import { db } from "../utils/db/index.js";
import type { Access } from "./access.js";
import type {
  Relation,
  Source,
  SourceColumn,
  SourceTable,
} from "../../prisma/generated/client/index.js";

export interface VisibleColumn {
  id: string;
  name: string;
  type: ColumnType;
  nativeType: string;
  nullable: boolean;
  description: string | null;
  missing: boolean;
}

export interface VisibleTable {
  id: string;
  schemaName: string;
  name: string;
  kind: SourceTable["kind"];
  description: string | null;
  missing: boolean;
  /** When an upload source's table was last loaded; null for a database source. */
  lastSyncedAt: Date | null;
  columns: VisibleColumn[];
}

export interface VisibleRelation {
  id: string;
  name: string;
  fromTableId: string;
  fromColumns: string[];
  toTableId: string;
  toColumns: string[];
  toMany: boolean;
  missing: boolean;
}

/** The only view of a source the query planner is given: granted columns, and the relations whose keys are all granted. */
export interface VisibleCatalog {
  source: {
    id: string;
    slug: string;
    name: string;
    description: string;
    type: SourceType;
    timeoutMs: number;
    rowCap: number;
    maxJoins: number;
    exportEnabled: boolean;
    exportRowCap: number;
    queryConcurrency: number;
    exportConcurrency: number;
  };
  tables: VisibleTable[];
  relations: VisibleRelation[];
  calendar: Calendar;
}

/** A stored measure (Task 8 narrows `formula` and `where`). */
export interface MeasureRow {
  id: string;
  sourceId: string;
  tableId: string;
  name: string;
  description: string;
  formula: unknown;
  where: unknown | null;
}

export const buildVisibleCatalog = (
  source: Source,
  tables: SourceTable[],
  columns: SourceColumn[],
  relations: Relation[],
  access: Access,
  // `measures` is consumed once measures reach the planner.
  extras: { calendar: Calendar; measures: MeasureRow[] }
): VisibleCatalog => {
  const columnsByTable = new Map<string, SourceColumn[]>();
  for (const column of columns) {
    const list = columnsByTable.get(column.tableId) ?? [];
    list.push(column);
    columnsByTable.set(column.tableId, list);
  }

  const visibleTables: VisibleTable[] = [];
  // Per visible table, the granted column names.
  const grantedNames = new Map<string, Set<string>>();
  // Per table, every column name the catalogue has, granted or not.
  const knownNames = new Map<string, Set<string>>();
  for (const table of tables) {
    const rows = [...(columnsByTable.get(table.id) ?? [])].sort(
      (a, b) => a.position - b.position
    );
    knownNames.set(table.id, new Set(rows.map((c) => c.name)));
    const granted = rows.filter((c) => access.allows(table.id, c.id));
    if (granted.length === 0) continue;
    grantedNames.set(table.id, new Set(granted.map((c) => c.name)));
    visibleTables.push({
      id: table.id,
      schemaName: table.schemaName,
      name: table.name,
      kind: table.kind,
      description: table.description,
      missing: table.missingSince !== null,
      lastSyncedAt: table.lastSyncedAt,
      columns: granted.map((c) => ({
        id: c.id,
        name: c.name,
        type: c.type,
        nativeType: c.nativeType,
        nullable: c.nullable,
        description: c.description,
        missing: c.missingSince !== null,
      })),
    });
  }

  const keysGranted = (tableId: string, names: string[]): boolean => {
    const granted = grantedNames.get(tableId);
    const known = knownNames.get(tableId);
    return (
      granted !== undefined &&
      known !== undefined &&
      names.every((n) => known.has(n) && granted.has(n))
    );
  };

  const visibleRelations: VisibleRelation[] = relations
    .filter(
      (r) =>
        keysGranted(r.fromTableId, r.fromColumns) &&
        keysGranted(r.toTableId, r.toColumns)
    )
    .map((r) => ({
      id: r.id,
      name: r.name,
      fromTableId: r.fromTableId,
      fromColumns: r.fromColumns,
      toTableId: r.toTableId,
      toColumns: r.toColumns,
      toMany: r.toMany,
      missing: r.missingSince !== null,
    }));

  return {
    source: {
      id: source.id,
      slug: source.slug,
      name: source.name,
      description: source.description,
      type: typeOf(source),
      timeoutMs: source.timeoutMs,
      rowCap: source.rowCap,
      maxJoins: source.maxJoins,
      exportEnabled: source.exportEnabled,
      exportRowCap: source.exportRowCap,
      queryConcurrency: source.queryConcurrency,
      exportConcurrency: source.exportConcurrency,
    },
    tables: visibleTables,
    relations: visibleRelations,
    calendar: extras.calendar,
  };
};

/** What a catalogue carries besides the source's own rows: the stored calendar, and measures once there are any. */
const loadExtras = async (): Promise<{
  calendar: Calendar;
  measures: MeasureRow[];
}> => ({ calendar: await loadCalendar(), measures: [] });

/** Null when the source does not exist, is archived, or the caller has no grant on it. */
export const loadVisibleCatalog = async (
  sourceSlug: string,
  access: Access
): Promise<VisibleCatalog | null> => {
  const source = await db.sources.findBySlug(sourceSlug);
  if (!source || source.archivedAt || !access.sourceIds.has(source.id)) {
    return null;
  }
  const { tables, columns, relations } = await db.catalog.loadSourceCatalog(
    source.id
  );
  return buildVisibleCatalog(
    source,
    tables,
    columns,
    relations,
    access,
    await loadExtras()
  );
};

/**
 * The source of a saved query as the caller may see it, by the id the saved
 * query holds. Never null: a source that is archived or that the caller has
 * no grant on is answered with no tables and no relations. Its catalogue is
 * loaded and built either way, so a hidden source costs about what a visible
 * one does.
 */
export const loadSourceVisibleCatalog = async (
  sourceId: string,
  access: Access
): Promise<VisibleCatalog> => {
  const source = await db.sources.findById(sourceId);
  // A saved query's source cannot be deleted: its foreign key restricts it.
  if (!source) throw new Error(`source ${sourceId} does not exist`);
  const { tables, columns, relations } =
    await db.catalog.loadSourceCatalog(sourceId);
  const catalog = buildVisibleCatalog(
    source,
    tables,
    columns,
    relations,
    access,
    await loadExtras()
  );
  const visible = !source.archivedAt && access.sourceIds.has(source.id);
  return visible ? catalog : { ...catalog, tables: [], relations: [] };
};
