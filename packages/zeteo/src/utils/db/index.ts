import * as sources from "./sources.js";
import * as catalog from "./catalog.js";

/**
 * One object across all tables. Each table's module is added here as it is
 * written, so callers write `db.sources.create(...)`.
 */
export const db = {
  sources,
  catalog,
};

export { prisma } from "./prisma.js";
export type { Prisma } from "./prisma.js";
