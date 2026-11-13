import type { Source } from "../../prisma/generated/client/index.js";
import type { SourceType } from "../adapters/types.js";

/** The API's name for a stored source type (`azure_sql` is `azure-sql`). */
export const typeOf = (row: Pick<Source, "type">): SourceType =>
  row.type === "azure_sql" ? "azure-sql" : row.type;

/** The stored enum value for an API source type. */
export const storedType = (type: SourceType): Source["type"] =>
  type === "azure-sql" ? "azure_sql" : type;
