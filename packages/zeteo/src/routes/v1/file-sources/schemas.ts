import { IdSchema } from "../../../utils/idSchema.js";
import { SLUG_PATTERN } from "../sources/schemas.js";
import { noNul } from "../../../utils/text.js";
import { z } from "zod";

const NAME = /^[a-z][a-z0-9_]{0,62}$/;
const NAME_MESSAGE =
  "A name is a lowercase letter, then lowercase letters, digits or _, at most 63";

export const ColumnNameSchema = z
  .string()
  .regex(NAME, { message: NAME_MESSAGE });

/** A table's name: as a column's, and never containing `__load_`, the mark of a load in progress. */
export const TableNameSchema = ColumnNameSchema.refine(
  (name) => !name.includes("__load_"),
  { message: "A table name cannot contain __load_" }
);

export const FileColumnTypeSchema = z.enum([
  "text",
  "number",
  "boolean",
  "date",
  "timestamp",
]);

export const ColumnCorrectionSchema = z.strictObject({
  index: z.number().int().min(0).max(1600),
  name: ColumnNameSchema.optional(),
  type: FileColumnTypeSchema.optional(),
});

/** The 0-based header row, or null for none. */
export const HeaderRowSchema = z.number().int().min(0).nullable();

export const TableKeySchema = z.string().min(1).max(1024);

export const TableCorrectionSchema = z.strictObject({
  key: TableKeySchema,
  name: TableNameSchema.optional(),
  header_row: HeaderRowSchema.optional(),
  columns: z.array(ColumnCorrectionSchema).max(1600).optional(),
});

export const TablesSchema = z.array(TableCorrectionSchema).min(1).max(100);

export const CreateFileSourceSchema = z.strictObject({
  staging_id: IdSchema,
  name: noNul(z.string().trim().min(1).max(255)),
  slug: z
    .string()
    .regex(SLUG_PATTERN, {
      message:
        "A slug is lower case letters, digits and hyphens, starting with a letter, 2 to 63 characters",
    })
    .optional(),
  tables: TablesSchema,
});

export const ListFileSourcesQuerySchema = z.strictObject({
  scope: z.enum(["mine", "all"]).default("mine"),
});
