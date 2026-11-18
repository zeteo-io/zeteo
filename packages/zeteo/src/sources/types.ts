import type { Source } from "../../prisma/generated/client/index.js";
import type { SourceType } from "../adapters/types.js";

/** The API's name for a stored source type (`azure_sql` is `azure-sql`). */
export const typeOf = (row: Pick<Source, "type">): SourceType =>
  row.type === "azure_sql"
    ? "azure-sql"
    : row.type === "google_sheets"
      ? "google-sheets"
      : row.type;

/** True for an upload source: data Zeteo stores itself, from files or a Google Sheet. */
export const isUploadSource = (row: Pick<Source, "type">): boolean =>
  row.type === "upload" || row.type === "google_sheets";

/** True for a Google Sheets source. */
export const isSheetsSource = (row: Pick<Source, "type">): boolean =>
  row.type === "google_sheets";

/** True for a source loaded from uploaded files only. */
export const isFileUpload = (row: Pick<Source, "type">): boolean =>
  row.type === "upload";

/** The stored enum value for an API source type. */
export const storedType = (type: SourceType): Source["type"] =>
  type === "azure-sql"
    ? "azure_sql"
    : type === "google-sheets"
      ? "google_sheets"
      : type;
