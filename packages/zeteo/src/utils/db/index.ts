import * as sources from "./sources.js";
import * as catalog from "./catalog.js";

/** One object across all tables: `db.sources.findById(...)`. */
export const db = {
  sources,
  catalog,
};

export { prisma } from "./prisma.js";
export type { Prisma } from "./prisma.js";
