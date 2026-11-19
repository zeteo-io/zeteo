import { loadVisibleCatalog } from "../grants/visibleCatalog.js";
import { visibleCatalogViews } from "../views/visibleCatalog.js";
import type { Access } from "../grants/access.js";
import { db } from "../utils/db/index.js";

/** The slugs of the sources the caller has a grant on, sorted. */
export const visibleSlugs = async (access: Access): Promise<string[]> =>
  (await db.sources.listSlugs(access.sourceIds)).sort();

/**
 * The caller's view of every source they have a grant on, by slug, with MCP's
 * row limits: what `list_sources` lists and the instructions name.
 */
export const listVisibleSources = async (access: Access) => {
  const catalogs = [];
  for (const slug of await visibleSlugs(access)) {
    const catalog = await loadVisibleCatalog(slug, access);
    if (catalog) catalogs.push(catalog);
  }
  return visibleCatalogViews(catalogs, () => null, "mcp");
};
