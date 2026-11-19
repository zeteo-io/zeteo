import type { CalcExpr, Filter } from "../../adapters/sql/language.js";
import type { MeasureRow } from "../../grants/visibleCatalog.js";
import { prisma, type Prisma } from "./prisma.js";
import type {
  Measure,
  MeasureEditor,
} from "../../../prisma/generated/client/index.js";

/** The stored JSON, read as the language's types: validated when saved, and again by `visibleMeasures` when loaded. */
export const toRow = (m: Measure): MeasureRow => ({
  id: m.id,
  sourceId: m.sourceId,
  tableId: m.tableId,
  name: m.name,
  description: m.description,
  formula: m.formula as unknown as CalcExpr,
  where: (m.where ?? null) as unknown as Filter | null,
  // Read when the columns exist; until then every measure is not fixed and has no date column.
  fixed: (m as { fixed?: boolean }).fixed ?? false,
  dateColumn: (m as { dateColumn?: string | null }).dateColumn ?? null,
});

/** Every measure of a source, by name. */
export const listBySource = async (sourceId: string): Promise<MeasureRow[]> =>
  (
    await prisma.measure.findMany({
      where: { sourceId },
      orderBy: { name: "asc" },
    })
  ).map(toRow);

/** Every stored measure of a source, by name, with who wrote it and when; through `client` when given (a transaction). */
export const listRecordsBySource = (
  sourceId: string,
  client: Prisma.TransactionClient | typeof prisma = prisma
): Promise<Measure[]> =>
  client.measure.findMany({
    where: { sourceId },
    orderBy: { name: "asc" },
  });

/** One measure of a source; null when there is none. */
export const findById = async (
  sourceId: string,
  id: string
): Promise<MeasureRow | null> => {
  const row = await prisma.measure.findFirst({ where: { sourceId, id } });
  return row ? toRow(row) : null;
};

/** The principals allowed to change a source's measures besides the admins. */
export const listEditors = (sourceId: string): Promise<MeasureEditor[]> =>
  prisma.measureEditor.findMany({
    where: { sourceId },
    orderBy: [{ principalType: "asc" }, { createdAt: "asc" }],
  });
