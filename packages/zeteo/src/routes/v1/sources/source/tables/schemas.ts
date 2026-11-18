import { IdSchema } from "../../../../../utils/idSchema.js";
import { noNul } from "../../../../../utils/text.js";
import { TablesSchema } from "../../schemas.js";
import { z } from "zod";

export const ListTablesQuerySchema = z.strictObject({
  include_missing: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  cursor: z.string().max(512).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

/** A list cursor's values: `schema_name`, then `name`. */
export const TableCursorSchema = z.tuple([
  noNul(z.string()),
  noNul(z.string()),
]);

/** An upload source's new tables, from the caller's staging. */
export const AddTablesSchema = z.strictObject({
  staging_id: IdSchema,
  tables: TablesSchema,
});
