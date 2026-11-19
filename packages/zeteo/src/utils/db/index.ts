import * as principalLimits from "./principalLimits.js";
import * as savedQueries from "./savedQueries.js";
import * as savedPanels from "./savedPanels.js";
import * as dashboards from "./dashboards.js";
import * as queryRuns from "./queryRuns.js";
import * as calendar from "./calendar.js";
import * as sources from "./sources.js";
import * as catalog from "./catalog.js";
import * as grants from "./grants.js";

/** One object across all tables: `db.sources.findById(...)`. */
export const db = {
  sources,
  calendar,
  catalog,
  grants,
  principalLimits,
  queryRuns,
  savedQueries,
  dashboards,
  savedPanels,
};

export { prisma } from "./prisma.js";
export type { Prisma } from "./prisma.js";
