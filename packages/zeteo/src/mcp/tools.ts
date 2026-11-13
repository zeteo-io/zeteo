import { loadVisibleCatalog } from "../grants/visibleCatalog.js";
import { visibleCatalogViews } from "../views/visibleCatalog.js";
import { loadAccess, type Access } from "../grants/access.js";
import { MCP_USE } from "../definitions/tereoDeclaration.js";
import type { TereoMcp, ToolContext } from "@tereo-io/mcp";
import { notFound } from "../engine/errors.js";
import { requireDataRead } from "./caller.js";
import { db } from "../utils/db/index.js";
import { asToolError } from "./errors.js";
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

/** The slugs of the sources the caller has a grant on, sorted. */
const visibleSlugs = async (access: Access): Promise<string[]> =>
  (await db.sources.listSlugs(access.sourceIds)).sort();

/**
 * The caller's view of one source with MCP's row limits, or the one error a
 * source they cannot see gets, whether it exists or not.
 */
const sourceView = async (access: Access, slug: string) => {
  const catalog = await loadVisibleCatalog(slug, access);
  // A source whose type has no adapter is left out, as from the listing.
  const [view] = catalog
    ? visibleCatalogViews([catalog], () => null, "mcp")
    : [];
  if (!view) {
    throw notFound("source", slug, ["source"], await visibleSlugs(access));
  }
  return view;
};

/** Runs `handler` for a caller with `zeteo.data.read`; zeteo's errors become tool errors. */
const handled =
  <I, R>(handler: (input: I, access: Access) => Promise<R>) =>
  async (input: I, ctx: ToolContext): Promise<R> => {
    try {
      const access = await loadAccess(requireDataRead(ctx.auth));
      return await handler(input, access);
    } catch (err) {
      return asToolError(err, ctx.requestId);
    }
  };

/** The read-only tools that show a caller what they may query: the names, never ids or native types. */
export const defineDiscoveryTools = (mcp: TereoMcp): void => {
  mcp.define({
    name: "list_sources",
    title: "List sources",
    description:
      "List the data sources you can query: each one's slug, name, database type, query language, how many tables you can see, and its row and time limits.",
    permission: MCP_USE,
    readOnly: true,
    handler: handled(async (_input: undefined, access) => {
      const catalogs = [];
      for (const slug of await visibleSlugs(access)) {
        const catalog = await loadVisibleCatalog(slug, access);
        if (catalog) catalogs.push(catalog);
      }
      const views = visibleCatalogViews(catalogs, () => null, "mcp");
      return {
        sources: views.map((view) => ({
          slug: view.slug,
          name: view.name,
          type: view.type,
          language: view.language.id,
          tables: view.tables.length,
          limits: {
            default_rows: view.limits.default_rows,
            max_rows: view.limits.max_rows,
            timeout_ms: view.limits.timeout_ms,
          },
        })),
      };
    }),
  });

  mcp.define({
    name: "list_tables",
    title: "List tables",
    description:
      "List the tables and views of a source that you can query, with their descriptions and how many of their columns you can see. Use describe_table for the columns.",
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
            columns: table.columns.length,
          })),
        };
      }
    ),
  });

  mcp.define({
    name: "describe_table",
    title: "Describe a table",
    description:
      "Show one table of a source: the columns you can query, with their types and descriptions, and its relations to other tables you can see.",
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
