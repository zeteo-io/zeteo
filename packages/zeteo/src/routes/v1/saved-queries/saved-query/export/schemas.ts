import { SavedQueryPagingSchema } from "../schemas.js";

export { ExportQuerySchema } from "../../../export/schemas.js";

/** `limit` and `offset` replacing the stored ones; no body exports it as stored. */
export const ExportSavedQuerySchema = SavedQueryPagingSchema;
