import { visibleMeasures, visibleMetrics } from "../measures/visible.js";
import type { CalcExpr, Filter } from "../adapters/sql/language.js";
import type { ColumnType, SourceType } from "../adapters/types.js";
import { rowsLimitedReason } from "../row-rules/describe.js";
import type { Calendar } from "../calendar/calendar.js";
import type { RowRule } from "../row-rules/resolve.js";
import { identityKeysOf } from "../row-rules/store.js";
import { loadCalendar } from "../calendar/service.js";
import { keysById } from "../identity/service.js";
import { typeOf } from "../sources/types.js";
import { logger } from "../utils/logger.js";
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
  /**
   * The caller's rows on the table when their grants limit them; absent when
   * every row is theirs. The planner reads the table through it wherever the
   * table is read. Its columns need not be granted, and are never shown.
   */
  rowRule?: RowRule;
  /**
   * When `rowRule` is set: the caller's rows in words, naming only columns
   * they are granted and identity keys by label, never their values.
   */
  rowsLimitedReason?: string;
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
  /** The measures whose expansion plans cleanly against this catalogue; see `visibleMeasures`. */
  measures: VisibleMeasure[];
  /** The metrics whose every measure is among `measures`; see `visibleMetrics`. */
  metrics: VisibleMetric[];
}

/** A stored metric: a named formula over measures of any tables of one source. */
export interface MetricRow {
  id: string;
  sourceId: string;
  name: string;
  description: string;
  /** Numbers, `{ measure }`, arithmetic and constant calendar functions; see `metricFormulaProblem`. */
  formula: CalcExpr;
}

/** A metric the caller may see and use: every measure it uses is theirs. */
export interface VisibleMetric {
  id: string;
  name: string;
  description: string;
  formula: CalcExpr;
}

/** A stored measure: a named group-level expression on one home table. */
export interface MeasureRow {
  id: string;
  sourceId: string;
  tableId: string;
  name: string;
  description: string;
  formula: CalcExpr;
  where: Filter | null;
  /** Computed over its whole home table, ignoring the query it is used in: a scalar subquery. */
  fixed: boolean;
  /** A date or timestamp column path from its home table, for metric queries; null when it has none. */
  dateColumn: string | null;
}

/** A measure the caller may see and use: every column and relation it reads is theirs. */
export interface VisibleMeasure {
  id: string;
  name: string;
  description: string;
  tableId: string;
  formula: CalcExpr;
  where: Filter | null;
  /** Computed over its whole home table, ignoring the query it is used in: a scalar subquery. */
  fixed: boolean;
  /** A date or timestamp column path from its home table, for metric queries; null when it has none. */
  dateColumn: string | null;
}

export const buildVisibleCatalog = (
  source: Source,
  tables: SourceTable[],
  columns: SourceColumn[],
  relations: Relation[],
  access: Access,
  extras: {
    calendar: Calendar;
    measures: MeasureRow[];
    metrics?: MetricRow[];
    /** Identity key labels by id, for `rowsLimitedReason`; see `keyLabelsFor`. */
    keyLabels?: Map<string, string>;
  }
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
    const rowRule = access.rowRule(table.id);
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
      ...(rowRule && {
        rowRule,
        rowsLimitedReason: rowsLimitedReason(
          rowRule,
          new Set(granted.map((c) => c.id)),
          extras.keyLabels ?? new Map()
        ),
      }),
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

  const catalog: Omit<VisibleCatalog, "measures" | "metrics"> = {
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
  const measures = visibleMeasures(catalog, extras.measures, (err, measureId) =>
    logger.warn(
      { err, measure_id: measureId },
      "A stored measure could not be planned; it is hidden"
    )
  );
  return {
    ...catalog,
    measures,
    metrics: visibleMetrics(
      { source: catalog.source, measures },
      extras.metrics ?? []
    ),
  };
};

/** What a catalogue carries besides the source's own rows: the stored calendar and the source's measures and metrics. */
const loadExtras = async (
  sourceId: string
): Promise<{
  calendar: Calendar;
  measures: MeasureRow[];
  metrics: MetricRow[];
}> => {
  const [calendar, measures, metrics] = await Promise.all([
    loadCalendar(),
    db.measures.listBySource(sourceId),
    db.metrics.listBySource(sourceId),
  ]);
  return { calendar, measures, metrics };
};

/**
 * The labels of the identity keys the caller's rules on `tables` use, by id;
 * read only when one does.
 */
const keyLabelsFor = async (
  tables: SourceTable[],
  access: Access
): Promise<Map<string, string>> => {
  const ids = identityKeysOf(
    tables.flatMap((t) => {
      const rule = access.rowRule(t.id);
      return rule?.kind === "filter"
        ? rule.descriptions.map((d) => d.stored)
        : [];
    })
  );
  if (ids.size === 0) return new Map();
  const keys = await keysById([...ids]);
  return new Map([...keys].map(([id, key]) => [id, key.label]));
};

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
  const [extras, keyLabels] = await Promise.all([
    loadExtras(source.id),
    keyLabelsFor(tables, access),
  ]);
  return buildVisibleCatalog(source, tables, columns, relations, access, {
    ...extras,
    keyLabels,
  });
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
  const [extras, keyLabels] = await Promise.all([
    loadExtras(source.id),
    keyLabelsFor(tables, access),
  ]);
  const catalog = buildVisibleCatalog(
    source,
    tables,
    columns,
    relations,
    access,
    { ...extras, keyLabels }
  );
  const visible = !source.archivedAt && access.sourceIds.has(source.id);
  return visible
    ? catalog
    : { ...catalog, tables: [], relations: [], measures: [], metrics: [] };
};
