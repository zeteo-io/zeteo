import { SavedQueryPagingSchema } from "../schemas.js";

/** `limit` and `offset` replacing the stored ones; no body runs it as stored. */
export const RunSavedQuerySchema = SavedQueryPagingSchema;
