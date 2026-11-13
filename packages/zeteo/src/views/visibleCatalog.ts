import type { VisibleCatalog } from "../grants/visibleCatalog.js";
import { LIMIT_PROFILES, runLimits } from "../engine/limits.js";
import { queryNameOf } from "../adapters/sql/plan.js";
import { adapterFor } from "../adapters/index.js";

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * What a caller may discover about one source: the names a query is written
 * with, and nothing else. Ids, native types, settings and every name outside
 * their grants stay out.
 */
export const visibleCatalogView = (
  catalog: VisibleCatalog,
  languageSchema: unknown
) => {
  const { source } = catalog;
  const tablesById = new Map(catalog.tables.map((t) => [t.id, t]));
  const nameOf = (id: string) => {
    const table = tablesById.get(id);
    return table && queryNameOf(catalog.tables, table);
  };
  const tables = [...catalog.tables].sort(
    (a, b) => compare(a.schemaName, b.schemaName) || compare(a.name, b.name)
  );
  return {
    slug: source.slug,
    name: source.name,
    type: source.type,
    language: {
      id: adapterFor(source.type).language.id,
      schema: languageSchema,
    },
    limits: {
      default_rows: runLimits("api", undefined, source).maxRows,
      max_rows: runLimits("api", LIMIT_PROFILES.api.maxRows, source).maxRows,
      timeout_ms: source.timeoutMs,
    },
    tables: tables.map((table) => ({
      name: queryNameOf(catalog.tables, table),
      schema_name: table.schemaName,
      kind: table.kind,
      description: table.description,
      missing: table.missing,
      columns: table.columns.map((c) => ({
        name: c.name,
        type: c.type,
        nullable: c.nullable,
        description: c.description,
        missing: c.missing,
      })),
      relations: catalog.relations
        .filter((r) => r.fromTableId === table.id)
        .flatMap((r) => {
          const to = nameOf(r.toTableId);
          return to === undefined
            ? []
            : [{ name: r.name, to, to_many: r.toMany, missing: r.missing }];
        }),
    })),
  };
};
