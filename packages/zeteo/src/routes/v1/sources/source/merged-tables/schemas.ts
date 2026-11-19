import { IdSchema } from "../../../../../utils/idSchema.js";
import { noNul } from "../../../../../utils/text.js";
import { z } from "zod";

/** A merged table's definition, to create one or replace one's. */
export const MergedTableSchema = z.strictObject({
  name: noNul(z.string().min(1).max(63)),
  label_column: noNul(z.string().min(1).max(63)),
  members: z
    .array(
      z.strictObject({
        table_id: IdSchema,
        // Trimmed, then at most 100 characters; the service says so.
        label: noNul(z.string().max(1000)),
      })
    )
    .min(2)
    .max(100),
  columns: z
    .array(
      z.strictObject({
        name: noNul(z.string().max(1000)),
        from_name: noNul(z.string().min(1).max(1000)),
        include: z.boolean(),
      })
    )
    .min(1)
    .max(1600),
});
