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
export const TableCursorSchema = z.tuple([z.string(), z.string()]);
