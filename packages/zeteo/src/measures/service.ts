import { resolveDateColumn, visibleDateColumn } from "./visible.js";
import { runQuery, type RunQueryResult } from "../engine/index.js";
import { notFoundMessage, QueryError } from "../engine/errors.js";
import type { SharePrincipal } from "../sharing/principals.js";
import { planSql, queryNameOf } from "../adapters/sql/plan.js";
import { mapUniqueViolation } from "../utils/prismaErrors.js";
import { loadAccess, type Access } from "../grants/access.js";
import { MeasureError } from "../adapters/sql/measures.js";
import { diffPrincipals } from "../sharing/principals.js";
import { hasPermission } from "../utils/permissions.js";
import { loadCalendar } from "../calendar/service.js";
import { toMetricRow } from "../utils/db/metrics.js";
import type { Caller } from "../middleware/auth.js";
import { withAudit } from "../utils/transaction.js";
import type { Prisma } from "../utils/db/prisma.js";
import { toRow } from "../utils/db/measures.js";
import { lockSourceMeasures } from "./lock.js";
import { typeOf } from "../sources/types.js";
import { db } from "../utils/db/index.js";
import { overlayDraft } from "./draft.js";
import {
  Prisma as PrismaRuntime,
  type Measure,
  type Metric,
  type Source,
} from "../../prisma/generated/client/index.js";
import {
  AUDIT_EVENTS,
  SOURCES_READ,
  SOURCES_WRITE,
} from "../definitions/tereoDeclaration.js";
import type {
  BUCKET_UNITS,
  CalcExpr,
  Filter,
} from "../adapters/sql/language.js";
import {
  buildVisibleCatalog,
  type MeasureRow,
  type MetricRow,
  type VisibleCatalog,
  type VisibleMeasure,
} from "../grants/visibleCatalog.js";
import {
  assertGroupsChecked,
  groupsInReach,
  shareViews,
} from "../sharing/shares.js";
import {
  measureEditorView,
  measureView,
  redactedMeasureView,
  type MeasureEditorView,
  type MeasureView,
  type RedactedMeasureView,
} from "../views/measure.js";
import {
  ConflictError,
  ForbiddenError,
  GroupNotAllowedError,
  InvalidMeasureError,
  MeasureInUseError,
  type MeasureDependent,
  NotFoundError,
  SourceArchivedError,
} from "../utils/errors.js";
import {
  checkMeasureSet,
  checkMetricSet,
  dependentsOf,
  metricsUsing,
  usedBy,
  type MeasureProblem,
} from "./dependents.js";
import {
  isMeasureEditor,
  mayManageEditors,
  seesAllMeasures,
} from "./access.js";

// A source's measures: listed as the caller may see them, and created,
// changed and deleted by its editors. A measure is checked twice when saved:
// planned alone against the editor's own catalogue (so an editor cannot
// define one over columns they are not granted), and, with every measure that
// uses it, against the source's whole catalogue (so no other measure breaks).

export interface MeasureInput {
  name: string;
  description: string;
  /** The home table's query name, as the editor's catalogue names it. */
  table: string;
  formula: CalcExpr;
  where?: Filter | null;
  /** Computed over its whole home table, ignoring the query it is used in. */
  fixed?: boolean;
  /** A date or timestamp column path from the home table, for metric queries. */
  date_column?: string | null;
}

type BucketUnit = (typeof BUCKET_UNITS)[number];

export type MeasureListItem = MeasureView | RedactedMeasureView;

/** The source's measures as the caller sees them, and what the caller may change. */
export interface MeasureList {
  items: MeasureListItem[];
  /** Whether the caller may create, change and delete measures now: an editor, on a source not archived. */
  canEdit: boolean;
  /** Whether the caller may replace the editor list now: `zeteo.sources.write` or the upload's owner, on a source not archived. */
  canManageEditors: boolean;
}

const NOT_FOUND = "Measure not found";
export const NOUN_TAKEN =
  "The source already has a measure or metric with this name";

/** The 409 for a name a measure or metric of the source has already. */
export const nameTaken = () =>
  new ConflictError(NOUN_TAKEN, "measure_name_taken");

/** The 403 for a caller who is not an editor of the source's measures. */
export const notEditor = () =>
  new ForbiddenError("Requires being an editor of this source's measures");

/** Every column of every table, as the structural checks see the source. */
const allAccess = (sourceId: string): Access => ({
  sourceIds: new Set([sourceId]),
  allows: () => true,
  tableAccess: () => "all",
});

export interface Catalogs {
  records: Measure[];
  rows: MeasureRow[];
  metricRecords: Metric[];
  metricRows: MetricRow[];
  /** The whole catalogue, every column granted, without measures or metrics. */
  full: Omit<VisibleCatalog, "measures">;
  /** The caller's catalogue with the measures they may use; null when the source is not theirs to query. */
  mine: VisibleCatalog | null;
}

/** What a source's catalogues are built from apart from its measures: read outside any transaction. */
export interface CatalogBase {
  catalog: Awaited<ReturnType<typeof db.catalog.loadSourceCatalog>>;
  calendar: Awaited<ReturnType<typeof loadCalendar>>;
}

export const loadCatalogBase = async (source: Source): Promise<CatalogBase> => {
  const [catalog, calendar] = await Promise.all([
    db.catalog.loadSourceCatalog(source.id),
    loadCalendar(),
  ]);
  return { catalog, calendar };
};

/** The source's catalogues for the caller from its tables and calendar and one read of its measures and metrics. `access` is loaded before any transaction. */
const catalogsOf = (
  source: Source,
  access: Access,
  { catalog, calendar }: CatalogBase,
  records: Measure[],
  metricRecords: Metric[]
): Catalogs => {
  const rows = records.map(toRow);
  const metricRows = metricRecords.map(toMetricRow);
  const build = (a: Access, measures: MeasureRow[], metrics: MetricRow[]) =>
    buildVisibleCatalog(
      source,
      catalog.tables,
      catalog.columns,
      catalog.relations,
      a,
      { calendar, measures, metrics }
    );
  const { measures: _none, ...full } = build(allAccess(source.id), [], []);
  const theirs = !source.archivedAt && access.sourceIds.has(source.id);
  return {
    records,
    rows,
    metricRecords,
    metricRows,
    full,
    mine: theirs ? build(access, rows, metricRows) : null,
  };
};

/** The source's catalogues for the caller, outside any transaction. */
export const loadCatalogs = async (
  source: Source,
  access: Access
): Promise<Catalogs> => {
  const [base, records, metricRecords] = await Promise.all([
    loadCatalogBase(source),
    db.measures.listRecordsBySource(source.id),
    db.metrics.listRecordsBySource(source.id),
  ]);
  return catalogsOf(source, access, base, records, metricRecords);
};

/**
 * The source's catalogues inside a change: the measures read through `tx`
 * after the source's measures are locked, so the checks see the rows no one
 * else can change until the transaction ends; `base` is read beforehand.
 */
export const lockedCatalogs = async (
  tx: Prisma.TransactionClient,
  source: Source,
  access: Access,
  base: CatalogBase
): Promise<Catalogs> => {
  await lockSourceMeasures(tx, source.id);
  return catalogsOf(
    source,
    access,
    base,
    await db.measures.listRecordsBySource(source.id, tx),
    await db.metrics.listRecordsBySource(source.id, tx)
  );
};

/** Whether a measure or metric of the source other than `exceptId` is named `name`. */
export const nameInUse = (
  catalogs: Pick<Catalogs, "rows" | "metricRows">,
  name: string,
  exceptId?: string
): boolean =>
  catalogs.rows.some((r) => r.name === name && r.id !== exceptId) ||
  catalogs.metricRows.some((m) => m.name === name && m.id !== exceptId);

/** The home table's query name: as the caller's catalogue names it, else as the whole one does. */
const tableNameOf = (
  tableId: string,
  catalogs: Pick<Catalogs, "full" | "mine">
): string => {
  for (const tables of [catalogs.mine?.tables, catalogs.full.tables]) {
    const table = tables?.find((t) => t.id === tableId);
    if (tables && table) return queryNameOf(tables, table);
  }
  return "";
};

/**
 * The measure's date column as the caller is shown it: as stored to those who
 * see every measure, else only when it resolves in their own catalogue.
 */
const shownDateColumn = (
  caller: Caller,
  source: Source,
  mine: VisibleCatalog | null,
  record: Measure
): string | null =>
  seesAllMeasures(caller, source)
    ? record.dateColumn
    : visibleDateColumn(mine, record);

/** Whether the caller may use the measure: it plans against their catalogue. */
const usableBy = (mine: VisibleCatalog | null, id: string): boolean =>
  mine?.measures.some((m) => m.id === id) ?? false;

const toVisible = (row: MeasureRow): VisibleMeasure => ({
  id: row.id,
  name: row.name,
  description: row.description,
  tableId: row.tableId,
  formula: row.formula,
  where: row.where,
  fixed: row.fixed,
  dateColumn: row.dateColumn,
});

/** The table `name` names in the editor's catalogue: not found otherwise, whether it exists or not. */
const resolveTable = (mine: VisibleCatalog | null, name: string): string => {
  const tables = mine?.tables ?? [];
  const table = tables.find((t) => queryNameOf(tables, t) === name);
  if (!table) {
    throw new InvalidMeasureError(
      "not_found_or_not_accessible",
      notFoundMessage("table", name),
      ["table"]
    );
  }
  return table.id;
};

/** A new measure's row from the request, its table resolved in the editor's catalogue. */
const draftOf = (
  source: Source,
  catalogs: Catalogs,
  input: MeasureInput
): MeasureRow => ({
  id: "",
  sourceId: source.id,
  tableId: resolveTable(catalogs.mine, input.table),
  name: input.name,
  description: input.description,
  formula: input.formula,
  where: input.where ?? null,
  fixed: input.fixed ?? false,
  dateColumn: input.date_column ?? null,
});

/**
 * The draft planned alone from its home table against the editor's
 * catalogue, with the other measures the editor may use: first its formula
 * alone, then with its `where`, so a refusal names the part at fault.
 */
const checkDraft = (
  mine: VisibleCatalog | null,
  draft: MeasureRow,
  /** Whether the date column is checked: when it is set, or the table changes. */
  checkDate = true
): void => {
  if (!mine) {
    throw new InvalidMeasureError(
      "not_found_or_not_accessible",
      "The measure's table was not found or is not accessible",
      ["table"]
    );
  }
  // The measures the editor may use as stored; one using the draft is
  // expanded with the draft, so a loop through it is found.
  const { measures: theirs, ...base } = mine;
  const others = theirs.filter(
    (m) => m.id !== draft.id && m.name !== draft.name
  );
  const home = base.tables.find((t) => t.id === draft.tableId);
  if (!home) {
    throw new InvalidMeasureError(
      "not_found_or_not_accessible",
      "The measure's table was not found or is not accessible",
      ["table"]
    );
  }
  const now = new Date();
  const plan = (candidate: MeasureRow, at: "formula" | "where") => {
    try {
      planSql(
        {
          source: base.source.slug,
          from: queryNameOf(base.tables, home),
          select: [{ measure: candidate.name }],
        },
        { ...base, measures: [...others, toVisible(candidate)] },
        { now }
      );
    } catch (err) {
      if (err instanceof QueryError || err instanceof MeasureError) {
        const path =
          err instanceof QueryError && err.path[0] === "from"
            ? ["table"]
            : [at];
        throw new InvalidMeasureError(err.code, err.message, path);
      }
      throw err;
    }
  };
  plan({ ...draft, where: null }, "formula");
  if (draft.where) plan(draft, "where");
  if (checkDate && draft.dateColumn !== null) {
    checkDateColumn({ ...base, measures: others }, home, draft.dateColumn);
  }
};

/**
 * The draft's date column resolved from its home table against the editor's
 * catalogue as a metric query resolves it: a path through to-one relations
 * to a date or timestamp column. Refused at `date_column` with the planner's
 * code otherwise; an ungranted column is not found, exactly as a nonexistent one.
 */
const checkDateColumn = (
  catalog: VisibleCatalog,
  home: VisibleCatalog["tables"][number],
  dateColumn: string
): void => {
  const at = ["date_column"];
  let type: string;
  try {
    type = resolveDateColumn(catalog, home, dateColumn, at);
  } catch (err) {
    if (err instanceof QueryError || err instanceof MeasureError) {
      throw new InvalidMeasureError(err.code, err.message, at);
    }
    throw err;
  }
  if (type !== "date" && type !== "timestamp") {
    throw new InvalidMeasureError(
      "invalid_operator",
      `A date column is a date or timestamp column; "${dateColumn}" is ${type}`,
      at
    );
  }
};

/** The measures and metrics that use the measure `name` at all, as a 409 names them. */
const usersOf = (
  name: string,
  catalogs: Pick<Catalogs, "rows" | "metricRows">
): MeasureDependent[] => {
  const measures = dependentsOf(name, catalogs.rows);
  return [
    ...measures.map((d) => ({ kind: "measure" as const, name: d.name })),
    ...metricsUsing(
      new Set([name, ...measures.map((d) => d.name)]),
      catalogs.metricRows
    ).map((m) => ({ kind: "metric" as const, name: m.name })),
  ];
};

/**
 * The draft, and every measure and metric that uses it (or used it as
 * `previousName`), planned against the source's whole catalogue. A dependent
 * that planned before and would not now refuses the save (a metric planned
 * alone and bucketed by month, so a date column it needs is kept); one
 * already broken does not.
 */
const checkSet = (
  { full, rows, metricRows }: Catalogs,
  draft: MeasureRow,
  previousName?: string
): void => {
  const after = overlayDraft(rows, draft);
  const affected = new Set([
    draft.name,
    ...dependentsOf(draft.name, after).map((r) => r.name),
    ...(previousName
      ? dependentsOf(previousName, rows).map((r) => r.name)
      : []),
  ]);
  const brokenBefore = new Set(
    checkMeasureSet(rows, full, affected).map((p) => p.name)
  );
  const problems = checkMeasureSet(after, full, affected);
  const own = problems.find((p) => p.name === draft.name);
  if (own) throw new InvalidMeasureError(own.code, own.message, ["formula"]);
  const breaking = problems
    .filter((p) => !brokenBefore.has(p.name))
    .map((p) => p.name)
    .sort();
  const usingMetrics = new Set(
    metricsUsing(affected, metricRows).map((m) => m.name)
  );
  const metricsBefore = new Map(
    checkMetricSet(metricRows, rows, full, usingMetrics).map((c) => [c.name, c])
  );
  const breakingMetrics = checkMetricSet(metricRows, after, full, usingMetrics)
    .filter((c) => {
      const before = metricsBefore.get(c.name);
      return (
        (before?.plain === null && c.plain !== null) ||
        (before?.bucketed === null && c.bucketed !== null)
      );
    })
    .map((c) => c.name)
    .sort();
  if (breaking.length > 0 || breakingMetrics.length > 0) {
    throw new MeasureInUseError([
      ...breaking.map((name) => ({ kind: "measure" as const, name })),
      ...breakingMetrics.map((name) => ({ kind: "metric" as const, name })),
    ]);
  }
};

/** The source, or the 404 (to those who may read sources) or 403 a caller who could not edit it gets. */
export const findSourceFor = async (
  caller: Caller,
  sourceId: string,
  notFound: string
): Promise<Source> => {
  const source = await db.sources.findById(sourceId);
  if (!source) {
    throw hasPermission(caller.permissions, SOURCES_READ)
      ? new NotFoundError(notFound)
      : notEditor();
  }
  return source;
};

/** The source the caller edits the measures of: 403 for anyone else, 409 once archived. */
export const editableSource = async (
  caller: Caller,
  sourceId: string,
  notFound: string
): Promise<Source> => {
  const source = await findSourceFor(caller, sourceId, notFound);
  if (!(await isMeasureEditor(caller, source))) throw notEditor();
  if (source.archivedAt) throw new SourceArchivedError();
  return source;
};

const brokenOf = (
  problems: readonly MeasureProblem[],
  name: string
): { code: string; message: string } | null => {
  const problem = problems.find((p) => p.name === name);
  return problem ? { code: problem.code, message: problem.message } : null;
};

/**
 * The source's measures as the caller may see them: every one in full to
 * those who see all (with whether each is usable by them and broken), the
 * ones they may use in full to anyone else, and, to an editor, the rest
 * redacted. A source the caller has nothing of is not found. With them,
 * whether the caller may change the measures and their editors.
 */
export const listMeasures = async (
  caller: Caller,
  sourceId: string
): Promise<MeasureList> => {
  const source = await db.sources.findById(sourceId);
  if (!source) throw new NotFoundError("Source not found");
  const all = seesAllMeasures(caller, source);
  const [editor, access] = await Promise.all([
    isMeasureEditor(caller, source),
    loadAccess(caller),
  ]);
  const catalogs = await loadCatalogs(source, access);
  if (!all && !editor && !catalogs.mine) {
    throw new NotFoundError("Source not found");
  }
  const problems = all ? checkMeasureSet(catalogs.rows, catalogs.full) : [];
  const items = await Promise.all(
    catalogs.records.map(async (record): Promise<MeasureListItem | null> => {
      const table = tableNameOf(record.tableId, catalogs);
      const usable = usableBy(catalogs.mine, record.id);
      if (!all && !usable) {
        return editor ? redactedMeasureView(record, table) : null;
      }
      return measureView(record, table, {
        usable,
        dateColumn: shownDateColumn(caller, source, catalogs.mine, record),
        ...((all || editor) && {
          usedBy: await usedBy(source.id, record.name),
        }),
        ...(all && { broken: brokenOf(problems, record.name) }),
      });
    })
  );
  const open = !source.archivedAt;
  return {
    items: items.filter((i): i is MeasureListItem => i !== null),
    canEdit: open && editor,
    canManageEditors: open && mayManageEditors(caller, source),
  };
};

/** One measure, to a caller who may see it in full; anyone else gets the 404 a measure that does not exist gives. */
export const getMeasure = async (
  caller: Caller,
  sourceId: string,
  id: string
): Promise<MeasureView> => {
  const source = await db.sources.findById(sourceId);
  if (!source) throw new NotFoundError(NOT_FOUND);
  const all = seesAllMeasures(caller, source);
  const [editor, access] = await Promise.all([
    isMeasureEditor(caller, source),
    loadAccess(caller),
  ]);
  const catalogs = await loadCatalogs(source, access);
  const record = catalogs.records.find((r) => r.id === id);
  const usable = record !== undefined && usableBy(catalogs.mine, record.id);
  if (!record || (!all && !usable)) throw new NotFoundError(NOT_FOUND);
  return measureView(record, tableNameOf(record.tableId, catalogs), {
    usable,
    dateColumn: shownDateColumn(caller, source, catalogs.mine, record),
    ...((all || editor) && { usedBy: await usedBy(source.id, record.name) }),
    ...(all && {
      broken: brokenOf(
        checkMeasureSet(catalogs.rows, catalogs.full, new Set([record.name])),
        record.name
      ),
    }),
  });
};

/** A measure just written, its table's name and its date column as its editor is shown it. */
interface Written {
  record: Measure;
  table: string;
  dateColumn: string | null;
}

/** The view of a measure just written, for the editor who wrote it. */
const writtenView = async (
  caller: Caller,
  source: Source,
  { record, table, dateColumn }: Written
): Promise<MeasureView> =>
  measureView(record, table, {
    usable: true,
    dateColumn,
    usedBy: await usedBy(source.id, record.name),
    ...(seesAllMeasures(caller, source) && { broken: null }),
  });

/** Creates a measure; the editor must be able to use it, and so must the source's whole catalogue. */
export const createMeasure = async (
  caller: Caller,
  sourceId: string,
  input: MeasureInput
): Promise<MeasureView> => {
  const source = await editableSource(caller, sourceId, "Source not found");
  const [access, base] = await Promise.all([
    loadAccess(caller),
    loadCatalogBase(source),
  ]);
  const written = await withAudit(async (tx, audit): Promise<Written> => {
    const catalogs = await lockedCatalogs(tx, source, access, base);
    if (nameInUse(catalogs, input.name)) throw nameTaken();
    const draft = draftOf(source, catalogs, input);
    checkDraft(catalogs.mine, draft);
    checkSet(catalogs, draft);
    const created = await mapUniqueViolation(
      () =>
        tx.measure.create({
          data: {
            sourceId: source.id,
            tableId: draft.tableId,
            name: draft.name,
            description: draft.description,
            formula: draft.formula as Prisma.InputJsonValue,
            ...(draft.where && {
              where: draft.where as Prisma.InputJsonValue,
            }),
            fixed: draft.fixed,
            dateColumn: draft.dateColumn,
            createdBy: caller.userId,
            updatedBy: caller.userId,
          },
        }),
      NOUN_TAKEN,
      "measure_name_taken"
    );
    audit({
      action: AUDIT_EVENTS.measureCreated,
      resourceType: "measure",
      resourceId: created.id,
      actorId: caller.userId,
      metadata: {
        source_id: source.id,
        slug: source.slug,
        name: created.name,
        table_id: created.tableId,
      },
    });
    return {
      record: created,
      table: tableNameOf(created.tableId, catalogs),
      dateColumn: shownDateColumn(caller, source, catalogs.mine, created),
    };
  });
  return writtenView(caller, source, written);
};

/**
 * The stored measure `id` for its editor, under the lock: the 404 a measure
 * that does not exist gives unless the editor sees it in full.
 */
const fullySeen = (
  caller: Caller,
  source: Source,
  catalogs: Catalogs,
  id: string
): Measure => {
  const record = catalogs.records.find((r) => r.id === id);
  if (
    !record ||
    (!seesAllMeasures(caller, source) && !usableBy(catalogs.mine, id))
  ) {
    throw new NotFoundError(NOT_FOUND);
  }
  return record;
};

/**
 * Changes a measure the editor sees in full. A rename is refused while other
 * measures use it; any change that would break one of them likewise.
 */
export const updateMeasure = async (
  caller: Caller,
  sourceId: string,
  id: string,
  patch: Partial<MeasureInput>
): Promise<MeasureView> => {
  const source = await editableSource(caller, sourceId, NOT_FOUND);
  const [access, base] = await Promise.all([
    loadAccess(caller),
    loadCatalogBase(source),
  ]);
  const written = await withAudit(async (tx, audit): Promise<Written> => {
    const catalogs = await lockedCatalogs(tx, source, access, base);
    const before = fullySeen(caller, source, catalogs, id);
    const old = toRow(before);
    if (patch.name !== undefined && patch.name !== old.name) {
      const dependents = usersOf(old.name, catalogs);
      if (dependents.length > 0) throw new MeasureInUseError(dependents);
      if (nameInUse(catalogs, patch.name, id)) throw nameTaken();
    }
    const tableId =
      patch.table === undefined
        ? old.tableId
        : resolveTable(catalogs.mine, patch.table);
    const draft: MeasureRow = {
      ...old,
      name: patch.name ?? old.name,
      description: patch.description ?? old.description,
      tableId,
      formula: patch.formula ?? old.formula,
      where: patch.where === undefined ? old.where : patch.where,
      fixed: patch.fixed ?? old.fixed,
      // A date column belongs to its table: moving the measure clears it
      // unless the change sets one.
      dateColumn:
        patch.date_column !== undefined
          ? patch.date_column
          : tableId !== old.tableId
            ? null
            : old.dateColumn,
    };
    // A stored date column the editor cannot see stays as it is: checked
    // only when the change sets it or moves the measure to another table (naming
    // its current table is no move).
    checkDraft(
      catalogs.mine,
      draft,
      patch.date_column !== undefined || tableId !== old.tableId
    );
    checkSet(catalogs, draft, old.name);
    const updated = await mapUniqueViolation(
      () =>
        tx.measure.update({
          where: { id },
          data: {
            name: draft.name,
            description: draft.description,
            tableId: draft.tableId,
            formula: draft.formula as Prisma.InputJsonValue,
            where:
              draft.where === null
                ? PrismaRuntime.DbNull
                : (draft.where as Prisma.InputJsonValue),
            fixed: draft.fixed,
            dateColumn: draft.dateColumn,
            updatedBy: caller.userId,
          },
        }),
      NOUN_TAKEN,
      "measure_name_taken"
    );
    audit({
      action: AUDIT_EVENTS.measureUpdated,
      resourceType: "measure",
      resourceId: id,
      actorId: caller.userId,
      metadata: {
        source_id: source.id,
        slug: source.slug,
        name: updated.name,
        changed: Object.keys(patch).sort(),
      },
    });
    return {
      record: updated,
      table: tableNameOf(updated.tableId, catalogs),
      dateColumn: shownDateColumn(caller, source, catalogs.mine, updated),
    };
  });
  return writtenView(caller, source, written);
};

/** Deletes a measure the editor sees in full; refused while other measures use it. Saved queries using it do not block. */
export const deleteMeasure = async (
  caller: Caller,
  sourceId: string,
  id: string
): Promise<void> => {
  const source = await editableSource(caller, sourceId, NOT_FOUND);
  const [access, base] = await Promise.all([
    loadAccess(caller),
    loadCatalogBase(source),
  ]);
  await withAudit(async (tx, audit) => {
    const catalogs = await lockedCatalogs(tx, source, access, base);
    const record = fullySeen(caller, source, catalogs, id);
    const dependents = usersOf(record.name, catalogs);
    if (dependents.length > 0) throw new MeasureInUseError(dependents);
    await tx.measure.delete({ where: { id } });
    audit({
      action: AUDIT_EVENTS.measureDeleted,
      resourceType: "measure",
      resourceId: id,
      actorId: caller.userId,
      metadata: {
        source_id: source.id,
        slug: source.slug,
        name: record.name,
      },
    });
  });
};

/**
 * Runs a draft measure, not saved, as its editor: checked as a save would
 * check it against the editor's catalogue, then queried from its home table,
 * alone or by `bucket`, with entry point `measure_preview` and the draft in
 * place of the stored measure of its name.
 */
export const previewMeasure = async (
  caller: Caller,
  sourceId: string,
  input: MeasureInput,
  bucket: { unit: BucketUnit; column: string } | undefined,
  signal?: AbortSignal
): Promise<RunQueryResult> => {
  const source = await editableSource(caller, sourceId, "Source not found");
  const catalogs = await loadCatalogs(source, await loadAccess(caller));
  const stored = catalogs.rows.find((r) => r.name === input.name);
  if (catalogs.metricRows.some((m) => m.name === input.name)) {
    throw nameTaken();
  }
  const draft = { ...draftOf(source, catalogs, input), id: stored?.id ?? "" };
  checkDraft(catalogs.mine, draft);
  // The bucket's column is named so it cannot be the measure's.
  const period = draft.name === "period" ? "period_start" : "period";
  const body = {
    source: source.slug,
    from: input.table,
    select: [
      ...(bucket
        ? [{ bucket: bucket.unit, column: bucket.column, as: period }]
        : []),
      { measure: draft.name },
    ],
    ...(bucket && { groupBy: [period], orderBy: [{ [period]: "asc" }] }),
  };
  return runQuery({
    caller,
    entryPoint: "measure_preview",
    body,
    draftMeasure: draft,
    signal,
  });
};

/** A source's editor list as stored. */
const editorsOf = async (sourceId: string): Promise<SharePrincipal[]> =>
  (await db.measures.listEditors(sourceId)).map((e) => ({
    type: e.principalType,
    id: e.principalId,
  }));

/** The source's editors with the directory's names, to its managers and its editors. */
export const listEditors = async (
  caller: Caller,
  sourceId: string
): Promise<MeasureEditorView[]> => {
  const source = await readableEditorsSource(caller, sourceId);
  const rows = await db.measures.listEditors(source.id);
  return (await shareViews(rows)).map(measureEditorView);
};

/** The source whose editor list the caller may read: its managers and its editors. */
const readableEditorsSource = async (
  caller: Caller,
  sourceId: string
): Promise<Source> => {
  const source = await findSourceFor(caller, sourceId, "Source not found");
  if (
    !mayManageEditors(caller, source) &&
    !(await isMeasureEditor(caller, source))
  ) {
    throw notEditor();
  }
  return source;
};

/**
 * Replaces the source's editor list. An upload source's owner may name only
 * groups global or of their signed-in organization, as for grants; a group
 * listed already stays without being checked again.
 */
export const replaceEditors = async (
  caller: Caller,
  sourceId: string,
  principals: SharePrincipal[]
): Promise<void> => {
  const source = await db.sources.findById(sourceId);
  if (!source) throw new NotFoundError("Source not found");
  if (!mayManageEditors(caller, source)) {
    throw new ForbiddenError(
      "Requires the zeteo.sources.write permission or owning the upload source"
    );
  }
  if (source.archivedAt) throw new SourceArchivedError();
  const asOwner = !hasPermission(caller.permissions, SOURCES_WRITE);
  let checked: string[] = [];
  if (asOwner) {
    const listed = new Set(
      (await editorsOf(source.id))
        .filter((p) => p.type === "group")
        .map((p) => p.id)
    );
    checked = principals
      .filter((p) => p.type === "group" && !listed.has(p.id))
      .map((p) => p.id);
    // Tereo is asked here, before the transaction.
    if (!(await groupsInReach(caller, checked))) {
      throw new GroupNotAllowedError();
    }
  }
  await withAudit(async (tx, audit) => {
    await lockSourceMeasures(tx, source.id);
    const existing = (
      await tx.measureEditor.findMany({ where: { sourceId: source.id } })
    ).map((e) => ({ type: e.principalType, id: e.principalId }));
    const { added, removed } = diffPrincipals(existing, principals);
    // A group listed when checked and removed meanwhile would come back unchecked.
    if (asOwner) assertGroupsChecked(added, checked);
    for (const p of removed) {
      await tx.measureEditor.delete({
        where: {
          sourceId_principalType_principalId: {
            sourceId: source.id,
            principalType: p.type,
            principalId: p.id,
          },
        },
      });
    }
    if (added.length > 0) {
      await tx.measureEditor.createMany({
        data: added.map((p) => ({
          sourceId: source.id,
          principalType: p.type,
          principalId: p.id,
          createdBy: caller.userId,
        })),
      });
    }
    audit({
      action: AUDIT_EVENTS.measureEditorsUpdated,
      resourceType: "source",
      resourceId: source.id,
      actorId: caller.userId,
      metadata: {
        slug: source.slug,
        type: typeOf(source),
        added,
        removed,
      },
    });
  });
};
