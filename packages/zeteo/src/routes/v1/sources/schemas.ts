import { CursorDateSchema } from "../../../utils/cursor.js";
import { IdSchema } from "../../../utils/idSchema.js";
import { noNul } from "../../../utils/text.js";
import { z } from "zod";

/** The database CHECK on `sources.slug`. */
export const SLUG_PATTERN = /^[a-z][a-z0-9-]{1,62}$/;

/**
 * A database schema name as Zeteo accepts it: 1 to 63 bytes (Postgres's limit),
 * no control characters, no leading or trailing whitespace. Names reach the
 * source only as bound parameters; this keeps stray input out of the catalogue.
 */
const SchemaNameSchema = z
  .string()
  .refine((name) => Buffer.byteLength(name) >= 1, {
    message: "A schema name cannot be empty",
  })
  .refine((name) => Buffer.byteLength(name) <= 63, {
    message: "A schema name is at most 63 bytes",
  })
  .refine((name) => !/\p{Cc}/u.test(name), {
    message: "A schema name has no control characters",
  })
  .refine((name) => name === name.trim(), {
    message: "A schema name has no leading or trailing whitespace",
  });

/** The fields a create sets and an update may change, other than `slug` and `type`. */
export const SourceFieldsShape = {
  name: noNul(z.string().trim().min(1).max(255)),
  /** What the source holds, for the people and the AI that query it; empty clears it. */
  description: noNul(z.string().trim().max(500)),
  // The adapter of the source's type validates the contents.
  settings: z.record(z.string(), z.unknown()),
  schemas: z
    .array(SchemaNameSchema)
    .min(1)
    .max(20)
    .refine((names) => new Set(names).size === names.length, {
      message: "Schema names must be unique",
    }),
  allow_writable_login: z.boolean(),
  timeout_ms: z.number().int().min(1000).max(120_000),
  row_cap: z.number().int().min(1).max(50_000),
  max_joins: z.number().int().min(1).max(8),
  export_enabled: z.boolean(),
  export_row_cap: z.number().int().min(0).max(1_000_000),
  query_concurrency: z.number().int().min(1).max(50),
  export_concurrency: z.number().int().min(1).max(10),
};

const SlugSchema = z.string().regex(SLUG_PATTERN, {
  message:
    "A slug is lower case letters, digits and hyphens, starting with a letter, 2 to 63 characters",
});

export const CreateSourceSchema = z.strictObject({
  slug: SlugSchema,
  type: z.enum(["postgres", "azure-sql"]),
  name: SourceFieldsShape.name,
  description: SourceFieldsShape.description.optional(),
  settings: SourceFieldsShape.settings,
  schemas: SourceFieldsShape.schemas,
  allow_writable_login: SourceFieldsShape.allow_writable_login.optional(),
  timeout_ms: SourceFieldsShape.timeout_ms.optional(),
  row_cap: SourceFieldsShape.row_cap.optional(),
  max_joins: SourceFieldsShape.max_joins.optional(),
  export_enabled: SourceFieldsShape.export_enabled.optional(),
  export_row_cap: SourceFieldsShape.export_row_cap.optional(),
  query_concurrency: SourceFieldsShape.query_concurrency.optional(),
  export_concurrency: SourceFieldsShape.export_concurrency.optional(),
});

// An upload source's tables, as a staging is turned into them.

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

export const UploadColumnTypeSchema = z.enum([
  "text",
  "number",
  "boolean",
  "date",
  "timestamp",
]);

export const ColumnCorrectionSchema = z.strictObject({
  index: z.number().int().min(0).max(1600),
  name: ColumnNameSchema.optional(),
  type: UploadColumnTypeSchema.optional(),
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

/** An upload source, made from the caller's staging. */
export const CreateUploadSourceSchema = z.strictObject({
  type: z.literal("upload"),
  staging_id: IdSchema,
  name: SourceFieldsShape.name,
  description: SourceFieldsShape.description.optional(),
  slug: SlugSchema.optional(),
  tables: TablesSchema,
});

const TYPES = ["postgres", "azure-sql", "upload", "google-sheets"] as const;

export const ListSourcesQuerySchema = z.strictObject({
  include_archived: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  type: z.enum(TYPES).optional(),
  /** `me` for the caller, or a user's id. */
  owner_id: z.union([z.literal("me"), IdSchema]).optional(),
  cursor: z.string().max(512).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

/** A list cursor's values: `created_at` as an ISO string, then the id. */
export const SourceCursorSchema = z.tuple([CursorDateSchema, IdSchema]);
