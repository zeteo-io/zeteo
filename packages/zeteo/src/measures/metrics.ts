import type { Metric, Source } from "../../prisma/generated/client/index.js";
import type { MetricRow, VisibleCatalog } from "../grants/visibleCatalog.js";
import { InvalidMeasureError, NotFoundError } from "../utils/errors.js";
import { runQuery, type RunQueryResult } from "../engine/index.js";
import { notFoundMessage, QueryError } from "../engine/errors.js";
import { AUDIT_EVENTS } from "../definitions/tereoDeclaration.js";
import { mapUniqueViolation } from "../utils/prismaErrors.js";
import { MeasureError } from "../adapters/sql/measures.js";
import type { PreviewProfile } from "../engine/limits.js";
import { checkMetricSet, usedBy } from "./dependents.js";
import { toMetricRow } from "../utils/db/metrics.js";
import type { Caller } from "../middleware/auth.js";
import { withAudit } from "../utils/transaction.js";
import type { Prisma } from "../utils/db/prisma.js";
import { loadAccess } from "../grants/access.js";
import { db } from "../utils/db/index.js";
import type {
  BUCKET_UNITS,
  CalcExpr,
  MetricQuery,
} from "../adapters/sql/language.js";
import {
  metricFormulaMeasures,
  metricFormulaProblem,
  planMetrics,
  usesPeriodBusinessDays,
} from "../adapters/sql/metrics.js";
import {
  metricView,
  redactedMetricView,
  type MetricView,
  type RedactedMetricView,
} from "../views/metric.js";
import {
  editableSource,
  lockedCatalogs,
  loadCatalogBase,
  loadCatalogs,
  nameInUse,
  nameTaken,
  NOUN_TAKEN,
  type Catalogs,
} from "./service.js";
import {
  isMeasureEditor,
  mayManageEditors,
  seesAllMeasures,
} from "./access.js";

// A source's metrics: named formulas over its measures, from any of its
// tables. Held to the measures' rules: the same editors and permissions, the
// same lock, names unique across measures and metrics, and a caller sees a
// metric in full only when every measure it uses is theirs. An editor sees
// the rest redacted; anyone else not at all, and a metric they cannot see
// answers exactly as one that does not exist.

export interface MetricInput {
  name: string;
  description: string;
  formula: CalcExpr;
}

type BucketUnit = (typeof BUCKET_UNITS)[number];

export type MetricListItem = MetricView | RedactedMetricView;

/** The source's metrics as the caller sees them, and what the caller may change. */
export interface MetricList {
  items: MetricListItem[];
  /** Whether the caller may create, change and delete metrics now: an editor, on a source not archived. */
  canEdit: boolean;
  /** Whether the caller may replace the editor list now, as for measures. */
  canManageEditors: boolean;
}

const NOT_FOUND = "Metric not found";

/** Whether the caller may use the metric: every measure it names is theirs. */
const usableBy = (mine: VisibleCatalog | null, id: string): boolean =>
  mine?.metrics.some((m) => m.id === id) ?? false;

/** Why a stored metric does not plan against the source's whole catalogue; null when it does. */
const brokenOf = (catalogs: Catalogs, name: string) =>
  checkMetricSet(
    catalogs.metricRows,
    catalogs.rows,
    catalogs.full,
    new Set([name])
  )[0]?.plain ?? null;

/**
 * The draft checked against the editor's catalogue: a metric's formula, every
 * measure it names one the editor may use (one they may not is not found,
 * exactly as one that does not exist), and planned as a metric query asking
 * for it alone.
 */
const checkDraft = (mine: VisibleCatalog | null, draft: MetricRow): void => {
  const problem = metricFormulaProblem(draft.formula);
  if (problem) {
    throw new InvalidMeasureError("invalid_operator", problem.message, [
      "formula",
      ...problem.path,
    ]);
  }
  const usable = new Set(mine?.measures.map((m) => m.name) ?? []);
  for (const name of metricFormulaMeasures(draft.formula)) {
    if (!mine || !usable.has(name)) {
      throw new InvalidMeasureError(
        "not_found_or_not_accessible",
        notFoundMessage("measure", name),
        ["formula"]
      );
    }
  }
  const catalog: VisibleCatalog = {
    ...mine!,
    metrics: [
      ...mine!.metrics.filter(
        (m) => m.id !== draft.id && m.name !== draft.name
      ),
      {
        id: draft.id,
        name: draft.name,
        description: draft.description,
        formula: draft.formula,
      },
    ],
  };
  try {
    planMetrics(
      {
        source: catalog.source.slug,
        metrics: [draft.name],
        ...(usesPeriodBusinessDays(draft.formula) && {
          bucket: "month" as const,
        }),
      },
      catalog,
      { now: new Date() }
    );
  } catch (err) {
    if (err instanceof QueryError || err instanceof MeasureError) {
      throw new InvalidMeasureError(err.code, err.message, ["formula"]);
    }
    throw err;
  }
};

/** The source, or the 404 a source that does not exist gives. */
const sourceOf = async (
  sourceId: string,
  notFound: string
): Promise<Source> => {
  const source = await db.sources.findById(sourceId);
  if (!source) throw new NotFoundError(notFound);
  return source;
};

/**
 * The source's metrics as the caller may see them: every one in full to
 * those who see all measures (with whether each is usable by them and
 * broken), the ones they may use in full to anyone else, and, to an editor,
 * the rest redacted. A source the caller has nothing of is not found.
 */
export const listMetrics = async (
  caller: Caller,
  sourceId: string
): Promise<MetricList> => {
  const source = await sourceOf(sourceId, "Source not found");
  const all = seesAllMeasures(caller, source);
  const [editor, access] = await Promise.all([
    isMeasureEditor(caller, source),
    loadAccess(caller),
  ]);
  const catalogs = await loadCatalogs(source, access);
  if (!all && !editor && !catalogs.mine) {
    throw new NotFoundError("Source not found");
  }
  const checks = all
    ? new Map(
        checkMetricSet(catalogs.metricRows, catalogs.rows, catalogs.full).map(
          (c) => [c.name, c.plain]
        )
      )
    : null;
  const items = await Promise.all(
    catalogs.metricRecords.map(
      async (record): Promise<MetricListItem | null> => {
        const usable = usableBy(catalogs.mine, record.id);
        if (!all && !usable) return editor ? redactedMetricView(record) : null;
        return metricView(record, {
          usable,
          ...((all || editor) && {
            usedBy: await usedBy(source.id, record.name, "metric"),
          }),
          ...(checks && { broken: checks.get(record.name) ?? null }),
        });
      }
    )
  );
  const open = !source.archivedAt;
  return {
    items: items.filter((i): i is MetricListItem => i !== null),
    canEdit: open && editor,
    canManageEditors: open && mayManageEditors(caller, source),
  };
};

/** One metric, to a caller who may see it in full; anyone else gets the 404 a metric that does not exist gives. */
export const getMetric = async (
  caller: Caller,
  sourceId: string,
  id: string
): Promise<MetricView> => {
  const source = await sourceOf(sourceId, NOT_FOUND);
  const all = seesAllMeasures(caller, source);
  const [editor, access] = await Promise.all([
    isMeasureEditor(caller, source),
    loadAccess(caller),
  ]);
  const catalogs = await loadCatalogs(source, access);
  const record = catalogs.metricRecords.find((r) => r.id === id);
  const usable = record !== undefined && usableBy(catalogs.mine, record.id);
  if (!record || (!all && !usable)) throw new NotFoundError(NOT_FOUND);
  return metricView(record, {
    usable,
    ...((all || editor) && {
      usedBy: await usedBy(source.id, record.name, "metric"),
    }),
    ...(all && { broken: brokenOf(catalogs, record.name) }),
  });
};

/** The view of a metric just written, for the editor who wrote it. */
const writtenView = async (
  caller: Caller,
  source: Source,
  record: Metric
): Promise<MetricView> =>
  metricView(record, {
    usable: true,
    usedBy: await usedBy(source.id, record.name, "metric"),
    ...(seesAllMeasures(caller, source) && { broken: null }),
  });

/** Creates a metric over measures the editor may use; its name is not a measure's or metric's of the source. */
export const createMetric = async (
  caller: Caller,
  sourceId: string,
  input: MetricInput
): Promise<MetricView> => {
  const source = await editableSource(caller, sourceId, "Source not found");
  const [access, base] = await Promise.all([
    loadAccess(caller),
    loadCatalogBase(source),
  ]);
  const record = await withAudit(async (tx, audit) => {
    const catalogs = await lockedCatalogs(tx, source, access, base);
    if (nameInUse(catalogs, input.name)) throw nameTaken();
    checkDraft(catalogs.mine, { id: "", sourceId: source.id, ...input });
    const created = await mapUniqueViolation(
      () =>
        tx.metric.create({
          data: {
            sourceId: source.id,
            name: input.name,
            description: input.description,
            formula: input.formula as Prisma.InputJsonValue,
            createdBy: caller.userId,
            updatedBy: caller.userId,
          },
        }),
      NOUN_TAKEN,
      "measure_name_taken"
    );
    audit({
      action: AUDIT_EVENTS.metricCreated,
      resourceType: "metric",
      resourceId: created.id,
      actorId: caller.userId,
      metadata: { source_id: source.id, slug: source.slug, name: created.name },
    });
    return created;
  });
  return writtenView(caller, source, record);
};

/** The stored metric `id` for its editor, under the lock: the 404 a metric that does not exist gives unless the editor sees it in full. */
const fullySeen = (
  caller: Caller,
  source: Source,
  catalogs: Catalogs,
  id: string
): Metric => {
  const record = catalogs.metricRecords.find((r) => r.id === id);
  if (
    !record ||
    (!seesAllMeasures(caller, source) && !usableBy(catalogs.mine, id))
  ) {
    throw new NotFoundError(NOT_FOUND);
  }
  return record;
};

/** Changes a metric the editor sees in full. Saved queries using it do not block a rename. */
export const updateMetric = async (
  caller: Caller,
  sourceId: string,
  id: string,
  patch: Partial<MetricInput>
): Promise<MetricView> => {
  const source = await editableSource(caller, sourceId, NOT_FOUND);
  const [access, base] = await Promise.all([
    loadAccess(caller),
    loadCatalogBase(source),
  ]);
  const record = await withAudit(async (tx, audit) => {
    const catalogs = await lockedCatalogs(tx, source, access, base);
    const old = toMetricRow(fullySeen(caller, source, catalogs, id));
    if (patch.name !== undefined && nameInUse(catalogs, patch.name, id)) {
      throw nameTaken();
    }
    const draft: MetricRow = {
      ...old,
      name: patch.name ?? old.name,
      description: patch.description ?? old.description,
      formula: patch.formula ?? old.formula,
    };
    checkDraft(catalogs.mine, draft);
    const updated = await mapUniqueViolation(
      () =>
        tx.metric.update({
          where: { id },
          data: {
            name: draft.name,
            description: draft.description,
            formula: draft.formula as Prisma.InputJsonValue,
            updatedBy: caller.userId,
          },
        }),
      NOUN_TAKEN,
      "measure_name_taken"
    );
    audit({
      action: AUDIT_EVENTS.metricUpdated,
      resourceType: "metric",
      resourceId: id,
      actorId: caller.userId,
      metadata: {
        source_id: source.id,
        slug: source.slug,
        name: updated.name,
        changed: Object.keys(patch).sort(),
      },
    });
    return updated;
  });
  return writtenView(caller, source, record);
};

/** Deletes a metric the editor sees in full. Saved queries using it do not block. */
export const deleteMetric = async (
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
    await tx.metric.delete({ where: { id } });
    audit({
      action: AUDIT_EVENTS.metricDeleted,
      resourceType: "metric",
      resourceId: id,
      actorId: caller.userId,
      metadata: { source_id: source.id, slug: source.slug, name: record.name },
    });
  });
};

/**
 * Runs a draft metric, not saved, as its editor: checked as a save would
 * check it, then asked for in a metric query, alone or by `bucket` and within
 * `range`, with entry point `measure_preview` and the draft in place of the
 * stored metric of its name, under `profile`'s limits (MCP's for the MCP tool).
 */
export const previewMetric = async (
  caller: Caller,
  sourceId: string,
  input: MetricInput,
  options: { bucket?: BucketUnit; range?: MetricQuery["range"] },
  signal?: AbortSignal,
  profile: PreviewProfile = "api"
): Promise<RunQueryResult> => {
  const source = await editableSource(caller, sourceId, "Source not found");
  const catalogs = await loadCatalogs(source, await loadAccess(caller));
  // A measure of this name would be asked for in the draft's place.
  if (catalogs.rows.some((r) => r.name === input.name)) throw nameTaken();
  const stored = catalogs.metricRows.find((m) => m.name === input.name);
  const draft: MetricRow = {
    id: stored?.id ?? "",
    sourceId: source.id,
    ...input,
  };
  checkDraft(catalogs.mine, draft);
  const body = {
    source: source.slug,
    metrics: [draft.name],
    ...(options.bucket && {
      bucket: options.bucket,
      orderBy: [{ period: "asc" }],
    }),
    ...(options.range && { range: options.range }),
  };
  return runQuery({
    caller,
    entryPoint: "measure_preview",
    body,
    draftMetric: draft,
    signal,
    limitProfile: profile,
  });
};
