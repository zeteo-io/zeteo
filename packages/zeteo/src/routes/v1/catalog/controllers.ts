import { loadVisibleCatalog } from "../../../grants/visibleCatalog.js";
import { visibleCatalogViews } from "../../../views/visibleCatalog.js";
import { validateQuery } from "../../../utils/validateReq.js";
import type { SourceType } from "../../../adapters/types.js";
import { adapterFor } from "../../../adapters/index.js";
import { callerOf } from "../../../middleware/auth.js";
import { loadAccess } from "../../../grants/access.js";
import { CatalogQuerySchema } from "./schemas.js";
import type { Request, Response } from "express";
import { db } from "../../../utils/db/index.js";

const languageSchemas = new Map<SourceType, unknown>();

const languageSchemaOf = (type: SourceType): unknown => {
  if (!languageSchemas.has(type)) {
    languageSchemas.set(type, adapterFor(type).language.describe());
  }
  return languageSchemas.get(type);
};

export const getCatalog = async (req: Request, res: Response) => {
  const query = validateQuery(CatalogQuerySchema, req);
  const access = await loadAccess(callerOf(req));
  const slugs =
    query.source === undefined
      ? (await db.sources.listSlugs(access.sourceIds)).sort()
      : [query.source];

  const catalogs = [];
  for (const slug of slugs) {
    const catalog = await loadVisibleCatalog(slug, access);
    if (catalog) catalogs.push(catalog);
  }
  res
    .status(200)
    .json({ sources: visibleCatalogViews(catalogs, languageSchemaOf) });
};
