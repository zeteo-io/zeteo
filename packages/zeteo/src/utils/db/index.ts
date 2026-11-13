import * as queryRuns from "./queryRuns.js";
import * as sources from "./sources.js";
import * as catalog from "./catalog.js";
import * as grants from "./grants.js";

/** One object across all tables: `db.sources.findById(...)`. */
export const db = {
  sources,
  catalog,
  grants,
  queryRuns,
};

export { prisma } from "./prisma.js";
export type { Prisma } from "./prisma.js";
