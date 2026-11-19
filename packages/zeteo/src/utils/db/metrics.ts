import type { Metric } from "../../../prisma/generated/client/index.js";
import type { MetricRow } from "../../grants/visibleCatalog.js";
import type { CalcExpr } from "../../adapters/sql/language.js";
import { prisma, type Prisma } from "./prisma.js";

/** The stored JSON, read as the language's type: validated when saved, and again by `visibleMetrics` when loaded. */
export const toMetricRow = (m: Metric): MetricRow => ({
  id: m.id,
  sourceId: m.sourceId,
  name: m.name,
  description: m.description,
  formula: m.formula as unknown as CalcExpr,
});

/** Every metric of a source, by name. */
export const listBySource = async (sourceId: string): Promise<MetricRow[]> =>
  (
    await prisma.metric.findMany({
      where: { sourceId },
      orderBy: { name: "asc" },
    })
  ).map(toMetricRow);

/** Every stored metric of a source, by name, with who wrote it and when; through `client` when given (a transaction). */
export const listRecordsBySource = (
  sourceId: string,
  client: Prisma.TransactionClient | typeof prisma = prisma
): Promise<Metric[]> =>
  client.metric.findMany({
    where: { sourceId },
    orderBy: { name: "asc" },
  });
