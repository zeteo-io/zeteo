import { runQuery, type RunQueryResult } from "../engine/index.js";
import { notFoundMessage, QueryError } from "../engine/errors.js";
import { planSql, queryNameOf } from "../adapters/sql/plan.js";
import type { SharePrincipal } from "../sharing/principals.js";
import { mapUniqueViolation } from "../utils/prismaErrors.js";
import { loadAccess, type Access } from "../grants/access.js";
import { MeasureError } from "../adapters/sql/measures.js";
import { diffPrincipals } from "../sharing/principals.js";
import { hasPermission } from "../utils/permissions.js";
import { loadCalendar } from "../calendar/service.js";
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
  NotFoundError,
  SourceArchivedError,
} from "../utils/errors.js";
import {
  checkMeasureSet,
  dependentsOf,
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
}

type BucketUnit = (typeof BUCKET_UNITS)[number];

export type MeasureListItem = MeasureView | RedactedMeasureView;

const NOT_FOUND = "Measure not found";
const NOUN_TAKEN = "The source already has a measure with this name";

/** The 403 for a caller who is not an editor of the source's measures. */
const notEditor = () =>
  new ForbiddenError("Requires being an editor of this source's measures");

/** Every column of every table, as the structural checks see the source. */
const allAccess = (sourceId: string): Access => ({
  sourceIds: new Set([sourceId]),
  allows: () => true,
  tableAccess: () => "all",
});

interface Catalogs {
  records: Measure[];
  rows: MeasureRow[];
  /** The whole catalogue, every column granted, without measures. */
  full: Omit<VisibleCatalog, "measures">;
  /** The caller's catalogue with the measures they may use; null when the source is not theirs to query. */
  mine: VisibleCatalog | null;
}

/** The source's catalogues for the caller, from one read of its rows. `access` is loaded before any transaction. */
const loadCatalogs = async (
  source: Source,
  access: Access
): Promise<Catalogs> => {
  const [catalog, calendar, records] = await Promise.all([
    db.catalog.loadSourceCatalog(source.id),
    loadCalendar(),
    db.measures.listRecordsBySource(source.id),
  ]);
  const rows = records.map(toRow);
  const build = (a: Access, measures: MeasureRow[]) =>
    buildVisibleCatalog(
      source,
      catalog.tables,
      catalog.columns,
      catalog.relations,
      a,
      { calendar, measures }
    );
  const { measures: _none, ...full } = build(allAccess(source.id), []);
  const theirs = !source.archivedAt && access.sourceIds.has(source.id);
  return { records, rows, full, mine: theirs ? build(access, rows) : null };
};

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

/**
 * The draft planned alone from its home table against the editor's
 * catalogue, with the other measures the editor may use: first its formula
 * alone, then with its `where`, so a refusal names the part at fault.
 */
const checkDraft = (mine: VisibleCatalog | null, draft: MeasureRow): void => {
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
};

/**
 * The draft, and every measure that uses it (or used it as `previousName`),
 * planned against the source's whole catalogue. A dependent that planned
 * before and would not now refuses the save; one already broken does not.
 */
const checkSet = (
  full: Omit<VisibleCatalog, "measures">,
  rows: readonly MeasureRow[],
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
  if (breaking.length > 0) throw new MeasureInUseError(breaking);
};

/** The source, or the 404 (to those who may read sources) or 403 a caller who could not edit it gets. */
const findSourceFor = async (
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
const editableSource = async (
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
 * redacted. A source the caller has nothing of is not found.
 */
export const listMeasures = async (
  caller: Caller,
  sourceId: string
): Promise<MeasureListItem[]> => {
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
        ...((all || editor) && {
          usedBy: await usedBy(source.id, record.name),
        }),
        ...(all && { broken: brokenOf(problems, record.name) }),
      });
    })
  );
  return items.filter((i): i is MeasureListItem => i !== null);
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
    ...((all || editor) && { usedBy: await usedBy(source.id, record.name) }),
    ...(all && {
      broken: brokenOf(
        checkMeasureSet(catalogs.rows, catalogs.full, new Set([record.name])),
        record.name
      ),
    }),
  });
};

/** The view of a measure just written, for the editor who wrote it. */
const writtenView = async (
  caller: Caller,
  source: Source,
  record: Measure,
  table: string
): Promise<MeasureView> =>
  measureView(record, table, {
    usable: true,
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
  const access = await loadAccess(caller);
  const { record, table } = await withAudit(async (tx, audit) => {
    await lockSourceMeasures(tx, source.id);
    const catalogs = await loadCatalogs(source, access);
    if (catalogs.rows.some((r) => r.name === input.name)) {
      throw new ConflictError(NOUN_TAKEN, "measure_name_taken");
    }
    const draft: MeasureRow = {
      id: "",
      sourceId: source.id,
      tableId: resolveTable(catalogs.mine, input.table),
      name: input.name,
      description: input.description,
      formula: input.formula,
      where: input.where ?? null,
    };
    checkDraft(catalogs.mine, draft);
    checkSet(catalogs.full, catalogs.rows, draft);
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
    };
  });
  return writtenView(caller, source, record, table);
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
  const access = await loadAccess(caller);
  const { record, table } = await withAudit(async (tx, audit) => {
    await lockSourceMeasures(tx, source.id);
    const catalogs = await loadCatalogs(source, access);
    const before = fullySeen(caller, source, catalogs, id);
    const old = toRow(before);
    if (patch.name !== undefined && patch.name !== old.name) {
      const dependents = dependentsOf(old.name, catalogs.rows);
      if (dependents.length > 0) {
        throw new MeasureInUseError(dependents.map((d) => d.name));
      }
      if (catalogs.rows.some((r) => r.name === patch.name)) {
        throw new ConflictError(NOUN_TAKEN, "measure_name_taken");
      }
    }
    const draft: MeasureRow = {
      ...old,
      name: patch.name ?? old.name,
      description: patch.description ?? old.description,
      tableId:
        patch.table === undefined
          ? old.tableId
          : resolveTable(catalogs.mine, patch.table),
      formula: patch.formula ?? old.formula,
      where: patch.where === undefined ? old.where : patch.where,
    };
    checkDraft(catalogs.mine, draft);
    checkSet(catalogs.full, catalogs.rows, draft, old.name);
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
    };
  });
  return writtenView(caller, source, record, table);
};

/** Deletes a measure the editor sees in full; refused while other measures use it. Saved queries using it do not block. */
export const deleteMeasure = async (
  caller: Caller,
  sourceId: string,
  id: string
): Promise<void> => {
  const source = await editableSource(caller, sourceId, NOT_FOUND);
  const access = await loadAccess(caller);
  await withAudit(async (tx, audit) => {
    await lockSourceMeasures(tx, source.id);
    const catalogs = await loadCatalogs(source, access);
    const record = fullySeen(caller, source, catalogs, id);
    const dependents = dependentsOf(record.name, catalogs.rows);
    if (dependents.length > 0) {
      throw new MeasureInUseError(dependents.map((d) => d.name));
    }
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
  const draft: MeasureRow = {
    id: stored?.id ?? "",
    sourceId: source.id,
    tableId: resolveTable(catalogs.mine, input.table),
    name: input.name,
    description: input.description,
    formula: input.formula,
    where: input.where ?? null,
  };
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
