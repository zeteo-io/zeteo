import type { Source } from "../../prisma/generated/client/index.js";
import type { SourceType } from "../adapters/types.js";

/** The API's name for a stored source type (`azure_sql` is `azure-sql`). */
export const typeOf = (row: Pick<Source, "type">): SourceType =>
  row.type === "azure_sql" ? "azure-sql" : row.type;

/** True for a file source: data Zeteo stores itself, loaded from uploads. */
export const isFileSource = (row: Pick<Source, "type">): boolean =>
  row.type === "upload";

/** The stored enum value for an API source type. */
export const storedType = (type: SourceType): Source["type"] =>
  type === "azure-sql" ? "azure_sql" : type;
