import { listVisibleSources, visibleSlugs } from "./visibleSources.js";
import { loadVisibleCatalog } from "../grants/visibleCatalog.js";
import { visibleCatalogViews } from "../views/visibleCatalog.js";
import { loadAccess, type Access } from "../grants/access.js";
import { MCP_USE } from "../definitions/tereoDeclaration.js";
import type { TereoMcp, ToolContext } from "@tereo-io/mcp";
import { notFound } from "../engine/errors.js";
import { requireDataRead } from "./caller.js";
import { inToolCall } from "./errors.js";
import { z } from "zod";

const SourceInput = z.object({
  source: z.string().min(1).max(200).describe("The source's slug"),
});

const TableInput = SourceInput.extend({
  table: z
    .string()
    .min(1)
    .max(512)
    .describe("The table's name as list_tables gives it"),
});

/**
 * The caller's view of one source with MCP's row limits, or the one error a
 * source they cannot see gets, whether it exists or not.
 */
const sourceView = async (access: Access, slug: string) => {
  const catalog = await loadVisibleCatalog(slug, access, { keyLabels: true });
  // A source whose type has no adapter is left out, as from the listing.
  const [view] = catalog
    ? visibleCatalogViews([catalog], () => null, "mcp")
    : [];
  if (!view) {
    throw notFound("source", slug, ["source"], await visibleSlugs(access));
  }
  return view;
};

/** How many measures a source's visible tables hold. */
const measureCount = (view: { tables: { measures: unknown[] }[] }): number =>
  view.tables.reduce((sum, t) => sum + t.measures.length, 0);

/** Runs `handler` for a caller with `zeteo.data.read`; zeteo's errors become tool errors. */
const handled =
  <I, R>(handler: (input: I, access: Access) => Promise<R>) =>
  (input: I, ctx: ToolContext): Promise<R> =>
    inToolCall(ctx, async () =>
      handler(input, await loadAccess(requireDataRead(ctx.auth)))
    );

/** The read-only tools that show a caller what they may query: the names, never ids or native types. */
export const defineDiscoveryTools = (mcp: TereoMcp): void => {
  mcp.define({
    name: "list_sources",
    title: "List sources",
    description:
      "List the data sources you can query: each one's slug, name, description of what it holds (empty when it has none), database type, kind (database or upload), query language, how many tables, measures and metrics you can see, and its row and time limits.",
    permission: MCP_USE,
    readOnly: true,
    handler: handled(async (_input: undefined, access) => {
      const views = await listVisibleSources(access);
      return {
        sources: views.map((view) => ({
          slug: view.slug,
          name: view.name,
          description: view.description,
          type: view.type,
          kind: view.kind,
          language: view.language.id,
          tables: view.tables.length,
          measures: measureCount(view),
          metrics: view.metrics.length,
          limits: {
            default_rows: view.limits.default_rows,
            max_rows: view.limits.max_rows,
            timeout_ms: view.limits.timeout_ms,
            max_joins: view.limits.max_joins,
          },
        })),
      };
    }),
  });

  mcp.define({
    name: "list_tables",
    title: "List tables",
    description:
      "List the tables and views of a source that you can query, with their descriptions and how many of their columns and measures you can see, whether your rows are limited (rows_limited), and the source's metrics (name, description, formula): cross-table calculations such as ROAS, queried with { metrics: [...] } (see query_guide). Use describe_table for the columns.",
    permission: MCP_USE,
    readOnly: true,
    input: SourceInput,
    handler: handled(
      async ({ source }: z.output<typeof SourceInput>, access) => {
        const view = await sourceView(access, source);
        return {
          source: view.slug,
          tables: view.tables.map((table) => ({
            name: table.name,
            schema_name: table.schema_name,
            kind: table.kind,
            description: table.description,
            missing: table.missing,
            last_loaded_at: table.last_loaded_at,
            columns: table.columns.length,
            measures: table.measures.length,
            rows_limited: table.rows_limited,
            ...(table.rows_limited && {
              rows_limited_reason: table.rows_limited_reason,
            }),
          })),
          metrics: view.metrics,
        };
      }
    ),
  });

  mcp.define({
    name: "describe_table",
    title: "Describe a table",
    description:
      'Show one table of a source: the columns you can query, with their types and descriptions, its relations to other tables you can see, and its measures (name, description, formula, filter, fixed, date_column): ready-made calculations to use in a query as { measure: name }; metrics are listed by list_tables. An upload source\'s table has last_loaded_at: the data is as of that time. rows_limited: you see only some rows, rows_limited_reason says which; say "your" figures, not totals.',
    permission: MCP_USE,
    readOnly: true,
    input: TableInput,
    handler: handled(
      async ({ source, table }: z.output<typeof TableInput>, access) => {
        const view = await sourceView(access, source);
        const found = view.tables.find((t) => t.name === table);
        if (!found) {
          throw notFound(
            "table",
            table,
            ["table"],
            view.tables.flatMap((t) => (t.name === undefined ? [] : [t.name]))
          );
        }
        return { source: view.slug, table: found };
      }
    ),
  });
};
