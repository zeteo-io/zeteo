import { IdSchema } from "../../../../../../utils/idSchema.js";
import { noNul } from "../../../../../../utils/text.js";
import { z } from "zod";
import {
  ColumnCorrectionSchema,
  HeaderRowSchema,
  TableKeySchema,
} from "../../../schemas.js";

export const TableParamsSchema = z.object({
  sourceId: IdSchema,
  tableId: IdSchema,
});

/** The longest description of a table or column. */
export const DESCRIPTION_MAX = 2000;

const Description = noNul(z.string().max(DESCRIPTION_MAX)).nullable();

/** `null` clears a description; what the body leaves out is not changed. */
export const PatchTableSchema = z
  .strictObject({
    description: Description.optional(),
    columns: z
      .array(
        z.strictObject({
          name: noNul(z.string().min(1).max(128)),
          description: Description,
        })
      )
      .min(1)
      .max(1000)
      .refine((cols) => new Set(cols.map((c) => c.name)).size === cols.length, {
        message: "Column names must be unique",
      })
      .optional(),
  })
  .refine((body) => Object.keys(body).length > 0, {
    message: "Give a description or columns to change",
  });

/** An upload source's table, loaded again from a staging. */
export const ReuploadTableSchema = z.strictObject({
  staging_id: IdSchema,
  key: TableKeySchema,
  header_row: HeaderRowSchema.optional(),
  columns: z.array(ColumnCorrectionSchema).max(1600).optional(),
});
