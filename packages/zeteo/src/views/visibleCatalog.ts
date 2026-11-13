import type { VisibleCatalog } from "../grants/visibleCatalog.js";
import { adapterFor, NoAdapterError } from "../adapters/index.js";
import { LIMIT_PROFILES, runLimits } from "../engine/limits.js";
import type { SourceType } from "../adapters/types.js";
import { logger } from "../utils/logger.js";

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
  const { language } = adapterFor(source.type);
  const queryNames = new Map(
    catalog.tables.map((t) => [t.id, language.tableName(catalog.tables, t)])
  );
  const relationsByTable = new Map<string, VisibleCatalog["relations"]>();
  for (const r of [...catalog.relations].sort((a, b) =>
    compare(a.name, b.name)
  )) {
    const list = relationsByTable.get(r.fromTableId) ?? [];
    list.push(r);
    relationsByTable.set(r.fromTableId, list);
  }
  const tables = [...catalog.tables].sort(
    (a, b) => compare(a.schemaName, b.schemaName) || compare(a.name, b.name)
  );
  return {
    slug: source.slug,
    name: source.name,
    type: source.type,
    language: {
      id: language.id,
      schema: languageSchema,
    },
    limits: {
      default_rows: runLimits("api", undefined, source).maxRows,
      max_rows: runLimits("api", LIMIT_PROFILES.api.maxRows, source).maxRows,
      timeout_ms: source.timeoutMs,
    },
    tables: tables.map((table) => ({
      name: queryNames.get(table.id),
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
      relations: (relationsByTable.get(table.id) ?? []).flatMap((r) => {
        const to = queryNames.get(r.toTableId);
        return to === undefined
          ? []
          : [{ name: r.name, to, to_many: r.toMany, missing: r.missing }];
      }),
    })),
  };
};

/**
 * The views of every catalogue in the list. A source whose type has no
 * adapter is left out and logged, so it cannot fail the whole listing.
 */
export const visibleCatalogViews = (
  catalogs: VisibleCatalog[],
  languageSchemaOf: (type: SourceType) => unknown
) => {
  const views = [];
  for (const catalog of catalogs) {
    try {
      views.push(
        visibleCatalogView(catalog, languageSchemaOf(catalog.source.type))
      );
    } catch (err) {
      if (!(err instanceof NoAdapterError)) throw err;
      logger.warn(
        { source: catalog.source.slug, type: catalog.source.type },
        "Skipping a source whose type has no adapter"
      );
    }
  }
  return views;
};
