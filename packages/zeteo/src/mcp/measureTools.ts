import { PreviewMeasureSchema } from "../routes/v1/sources/source/measures/preview/schemas.js";
import { UpdateMeasureSchema } from "../routes/v1/sources/source/measures/measure/schemas.js";
import { PreviewMetricSchema } from "../routes/v1/sources/source/metrics/preview/schemas.js";
import { UpdateMetricSchema } from "../routes/v1/sources/source/metrics/metric/schemas.js";
import { CreateMeasureSchema } from "../routes/v1/sources/source/measures/schemas.js";
import { CreateMetricSchema } from "../routes/v1/sources/source/metrics/schemas.js";
import { MCP_USE, MEASURES_WRITE } from "../definitions/tereoDeclaration.js";
import { ForbiddenError, NotFoundError } from "../utils/errors.js";
import { invalidRequest } from "../utils/validateReq.js";
import { hasPermission } from "../utils/permissions.js";
import { QUERY_TOOL_TIMEOUT_MS } from "./queryTool.js";
import type { Caller } from "../middleware/auth.js";
import type { AuthContext } from "@tereo-io/sdk";
import type { TereoMcp } from "@tereo-io/mcp";
import { requireDataRead } from "./caller.js";
import { db } from "../utils/db/index.js";
import { inToolCall } from "./errors.js";
import { z, type ZodType } from "zod";
import {
  createMetric,
  deleteMetric,
  listMetrics,
  previewMetric,
  updateMetric,
} from "../measures/metrics.js";
import {
  createMeasure,
  deleteMeasure,
  listMeasures,
  previewMeasure,
  updateMeasure,
} from "../measures/service.js";

// Measures and metrics belong to a source and everyone who queries it uses
// them, so changing one can change other people's numbers. The tools address
// them by source slug and name, as describe_table and list_tables show them,
// and do nothing the API would not let the same caller do: the same editor
// list, the same checks against the caller's own grants, the same refusals.
// Formulas and filters are declared with their JSON type only (a model client
// sends an argument the schema does not declare as a string) and checked here
// by the API's own schemas, so errors carry the same paths.

/** A source no row has: the services answer it as they answer any source the caller cannot reach. */
const NO_SOURCE = "00000000-0000-0000-0000-000000000000";

const SHARED_NOTE =
  "Measures and metrics are shared by everyone who queries the source, and saved queries and dashboards may use them: call this only when the user asks, and say what uses the measure or metric (list_measures, list_metrics: used_by) before changing or deleting it.";

const Source = z.string().min(1).max(64).describe("The source's slug");
const Json = z.unknown();

/** Parses `value` with one of the API's schemas, failing as the API would. */
const parse = <T extends ZodType>(schema: T, value: unknown): z.infer<T> => {
  const result = schema.safeParse(value);
  if (!result.success) throw invalidRequest("arguments", result.error);
  return result.data;
};

/** The caller, refused (`forbidden`) without `zeteo.measures.write`, as the API's write routes refuse them. */
const requireWriter = (auth: AuthContext): Caller => {
  const caller = requireDataRead(auth);
  if (!hasPermission(caller.permissions, MEASURES_WRITE)) {
    throw new ForbiddenError(`Requires the ${MEASURES_WRITE} permission`);
  }
  return caller;
};

const sourceIdOf = async (slug: string): Promise<string> =>
  (await db.sources.findBySlug(slug))?.id ?? NO_SOURCE;

/** A measure the caller sees in full, by name; any other answers as one that does not exist. */
const measureIdOf = async (caller: Caller, sourceId: string, name: string) => {
  const list = await listMeasures(caller, sourceId);
  const found = list.items.find((m) => m.name === name && "id" in m);
  if (!found || !("id" in found)) throw new NotFoundError("Measure not found");
  return found.id;
};

const metricIdOf = async (caller: Caller, sourceId: string, name: string) => {
  const list = await listMetrics(caller, sourceId);
  const found = list.items.find((m) => m.name === name && "id" in m);
  if (!found || !("id" in found)) throw new NotFoundError("Metric not found");
  return found.id;
};

/** Without the ids: the tools name measures and metrics. */
const withoutId = <T extends object>(view: T): Omit<T, "id"> => {
  const { id: _id, ...rest } = view as T & { id?: unknown };
  return rest;
};

const MeasureFields = {
  description: z
    .string()
    .describe(
      "What the measure means, for people and for Claude. Plain language, without column names or values: editors who are not granted everything it reads still see its name and description."
    ),
  table: z
    .string()
    .describe(
      "The table it is computed from, as list_tables names it (its home table)"
    ),
  formula: Json.describe(
    'A group-level expression, such as { "sum": "total" } or { "div": [{ "sum": "total" }, { "count": "*" }] }; see query_guide'
  ),
  where: Json.describe(
    "A filter on the home table's rows the formula counts, as a query's where"
  ),
  fixed: z
    .boolean()
    .describe(
      "One value over the whole table, ignoring the query's filters; usable from any table"
    ),
  date_column: z
    .string()
    .nullable()
    .describe(
      "A date or timestamp column (or a to-one relation's) that metric queries bucket and range it by"
    ),
};

const MetricFields = {
  description: z
    .string()
    .describe(
      "What the metric means. Plain language, without column names or values: editors who are not granted everything its measures read still see its name and description."
    ),
  formula: Json.describe(
    'Arithmetic over measures of any tables of the source, such as { "div": [{ "measure": "revenue" }, { "measure": "spend" }] }'
  ),
};

/** The tools to read and change a source's measures and metrics, for their editors. */
export const defineMeasureTools = (mcp: TereoMcp): void => {
  mcp.define({
    name: "list_measures",
    title: "List a source's measures",
    description:
      "List a source's measures with their definitions: name, description, table, formula, where, fixed, date_column, usable and, for editors, used_by (saved queries and panels). can_edit says whether you may create, change and delete them. A measure you cannot fully see shows only its name, table and description.",
    permission: MCP_USE,
    readOnly: true,
    input: z.strictObject({ source: Source }),
    handler: (input, ctx) =>
      inToolCall(ctx, async () => {
        const caller = requireDataRead(ctx.auth);
        const list = await listMeasures(caller, await sourceIdOf(input.source));
        return {
          measures: list.items.map(withoutId),
          can_edit: list.canEdit,
        };
      }),
  });

  mcp.define({
    name: "create_measure",
    title: "Create a measure",
    description: `Create a named measure on a table of a source, for you and everyone who queries it to use as { "measure": name }. Needs zeteo.measures.write and being one of the source's measure editors. It is checked against your own grants. Try it with preview_measure first. ${SHARED_NOTE}`,
    permission: MCP_USE,
    readOnly: false,
    destructive: false,
    input: z.strictObject({
      source: Source,
      name: z
        .string()
        .describe(
          "Lower case letters, digits and underscores; unique among the source's measures and metrics"
        ),
      ...MeasureFields,
      where: MeasureFields.where.optional(),
      fixed: MeasureFields.fixed.optional(),
      date_column: MeasureFields.date_column.optional(),
    }),
    handler: (input, ctx) =>
      inToolCall(ctx, async () => {
        const caller = requireWriter(ctx.auth);
        const { source, ...fields } = input;
        const body = parse(CreateMeasureSchema, fields);
        return withoutId(
          await createMeasure(caller, await sourceIdOf(source), body)
        );
      }),
  });

  mcp.define({
    name: "update_measure",
    title: "Change a measure",
    description: `Change a measure, found by its current name. Only what you give changes; where: null removes its filter and date_column: null its date column. Renaming breaks saved queries and panels that use the old name. ${SHARED_NOTE}`,
    permission: MCP_USE,
    readOnly: false,
    destructive: false,
    idempotent: true,
    input: z.strictObject({
      source: Source,
      measure: z.string().describe("The measure's current name"),
      name: z.string().optional().describe("A new name"),
      description: MeasureFields.description.optional(),
      table: MeasureFields.table.optional(),
      formula: MeasureFields.formula.optional(),
      where: MeasureFields.where.optional(),
      fixed: MeasureFields.fixed.optional(),
      date_column: MeasureFields.date_column.optional(),
    }),
    handler: (input, ctx) =>
      inToolCall(ctx, async () => {
        const caller = requireWriter(ctx.auth);
        const { source, measure, ...fields } = input;
        const patch = parse(UpdateMeasureSchema, fields);
        const sourceId = await sourceIdOf(source);
        const id = await measureIdOf(caller, sourceId, measure);
        return withoutId(await updateMeasure(caller, sourceId, id, patch));
      }),
  });

  mcp.define({
    name: "delete_measure",
    title: "Delete a measure",
    description: `Delete a measure for good. Refused while other measures or metrics use it; saved queries and panels that use it stop working. ${SHARED_NOTE}`,
    permission: MCP_USE,
    readOnly: false,
    destructive: true,
    idempotent: true,
    input: z.strictObject({
      source: Source,
      measure: z.string().describe("The measure's name"),
    }),
    handler: (input, ctx) =>
      inToolCall(ctx, async () => {
        const caller = requireWriter(ctx.auth);
        const sourceId = await sourceIdOf(input.source);
        const id = await measureIdOf(caller, sourceId, input.measure);
        await deleteMeasure(caller, sourceId, id);
        return { deleted: true };
      }),
  });

  mcp.define({
    name: "preview_measure",
    title: "Preview a measure",
    description:
      'Run a draft measure without saving it: checked as create_measure would check it, then computed over its table, alone or by a date bucket ({ unit: "month", column: "created_at" }). A draft with a stored measure\'s name stands in for it. Returns { columns, rows, truncated, warnings, run_id }. Needs what create_measure needs.',
    permission: MCP_USE,
    readOnly: true,
    timeoutMs: QUERY_TOOL_TIMEOUT_MS,
    input: z.strictObject({
      source: Source,
      name: z.string().describe("The draft's name"),
      ...MeasureFields,
      where: MeasureFields.where.optional(),
      fixed: MeasureFields.fixed.optional(),
      date_column: MeasureFields.date_column.optional(),
      bucket: z
        .record(z.string(), z.unknown())
        .optional()
        .describe('{ "unit": "month", "column": "created_at" }'),
    }),
    handler: (input, ctx) =>
      inToolCall(ctx, async () => {
        const caller = requireWriter(ctx.auth);
        const { source, bucket, ...measure } = input;
        const body = parse(PreviewMeasureSchema, { measure, bucket });
        return previewMeasure(
          caller,
          await sourceIdOf(source),
          body.measure,
          body.bucket,
          ctx.signal
        );
      }),
  });

  mcp.define({
    name: "list_metrics",
    title: "List a source's metrics",
    description:
      "List a source's metrics with their definitions: name, description, formula, usable and, for editors, used_by. can_edit says whether you may create, change and delete them. A metric using a measure you cannot fully see shows only its name and description.",
    permission: MCP_USE,
    readOnly: true,
    input: z.strictObject({ source: Source }),
    handler: (input, ctx) =>
      inToolCall(ctx, async () => {
        const caller = requireDataRead(ctx.auth);
        const list = await listMetrics(caller, await sourceIdOf(input.source));
        return { metrics: list.items.map(withoutId), can_edit: list.canEdit };
      }),
  });

  mcp.define({
    name: "create_metric",
    title: "Create a metric",
    description: `Create a named metric: a formula over measures of any tables of the source, asked for with { "metrics": [name] } in a query. Needs zeteo.measures.write and being one of the source's measure editors. Try it with preview_metric first. ${SHARED_NOTE}`,
    permission: MCP_USE,
    readOnly: false,
    destructive: false,
    input: z.strictObject({
      source: Source,
      name: z
        .string()
        .describe(
          "Lower case letters, digits and underscores; unique among the source's measures and metrics"
        ),
      ...MetricFields,
    }),
    handler: (input, ctx) =>
      inToolCall(ctx, async () => {
        const caller = requireWriter(ctx.auth);
        const { source, ...fields } = input;
        const body = parse(CreateMetricSchema, fields);
        return withoutId(
          await createMetric(caller, await sourceIdOf(source), body)
        );
      }),
  });

  mcp.define({
    name: "update_metric",
    title: "Change a metric",
    description: `Change a metric, found by its current name. Only what you give changes. Renaming breaks saved queries and panels that use the old name. ${SHARED_NOTE}`,
    permission: MCP_USE,
    readOnly: false,
    destructive: false,
    idempotent: true,
    input: z.strictObject({
      source: Source,
      metric: z.string().describe("The metric's current name"),
      name: z.string().optional().describe("A new name"),
      description: MetricFields.description.optional(),
      formula: MetricFields.formula.optional(),
    }),
    handler: (input, ctx) =>
      inToolCall(ctx, async () => {
        const caller = requireWriter(ctx.auth);
        const { source, metric, ...fields } = input;
        const patch = parse(UpdateMetricSchema, fields);
        const sourceId = await sourceIdOf(source);
        const id = await metricIdOf(caller, sourceId, metric);
        return withoutId(await updateMetric(caller, sourceId, id, patch));
      }),
  });

  mcp.define({
    name: "delete_metric",
    title: "Delete a metric",
    description: `Delete a metric for good; saved queries and panels that use it stop working. ${SHARED_NOTE}`,
    permission: MCP_USE,
    readOnly: false,
    destructive: true,
    idempotent: true,
    input: z.strictObject({
      source: Source,
      metric: z.string().describe("The metric's name"),
    }),
    handler: (input, ctx) =>
      inToolCall(ctx, async () => {
        const caller = requireWriter(ctx.auth);
        const sourceId = await sourceIdOf(input.source);
        const id = await metricIdOf(caller, sourceId, input.metric);
        await deleteMetric(caller, sourceId, id);
        return { deleted: true };
      }),
  });

  mcp.define({
    name: "preview_metric",
    title: "Preview a metric",
    description:
      'Run a draft metric without saving it, as a metric query: optionally by bucket ("month") and over a range ({ gte, lt } of dates or relative dates) on each measure\'s date column. Returns { columns, rows, truncated, warnings, run_id }. Needs what create_metric needs.',
    permission: MCP_USE,
    readOnly: true,
    timeoutMs: QUERY_TOOL_TIMEOUT_MS,
    input: z.strictObject({
      source: Source,
      name: z.string().describe("The draft's name"),
      ...MetricFields,
      bucket: z.string().optional().describe('A period, such as "month"'),
      range: z
        .record(z.string(), z.unknown())
        .optional()
        .describe("{ gte, lt } on each measure's date column"),
    }),
    handler: (input, ctx) =>
      inToolCall(ctx, async () => {
        const caller = requireWriter(ctx.auth);
        const { source, bucket, range, ...metric } = input;
        const body = parse(PreviewMetricSchema, { metric, bucket, range });
        return previewMetric(
          caller,
          await sourceIdOf(source),
          body.metric,
          {
            ...(body.bucket && { bucket: body.bucket }),
            ...(body.range && { range: body.range }),
          },
          ctx.signal
        );
      }),
  });
};
