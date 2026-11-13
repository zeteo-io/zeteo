import { CursorDateSchema } from "../../../utils/cursor.js";
import { IdSchema } from "../../../utils/idSchema.js";
import { z } from "zod";

/** The database CHECK on `sources.slug`. */
export const SLUG_PATTERN = /^[a-z][a-z0-9-]{1,62}$/;

/** The fields a create sets and an update may change, other than `slug` and `type`. */
export const SourceFieldsShape = {
  name: z.string().trim().min(1).max(255),
  // The adapter of the source's type validates the contents.
  settings: z.record(z.string(), z.unknown()),
  schemas: z
    .array(z.string().min(1).max(128))
    .min(1)
    .max(20)
    .refine((names) => new Set(names).size === names.length, {
      message: "Schema names must be unique",
    }),
  allow_writable_login: z.boolean(),
  timeout_ms: z.number().int().min(1000).max(120_000),
  row_cap: z.number().int().min(1).max(50_000),
  export_enabled: z.boolean(),
  export_row_cap: z.number().int().min(0).max(1_000_000),
};

export const CreateSourceSchema = z.strictObject({
  slug: z.string().regex(SLUG_PATTERN, {
    message:
      "A slug is lower case letters, digits and hyphens, starting with a letter, 2 to 63 characters",
  }),
  type: z.enum(["postgres", "azure-sql"]),
  name: SourceFieldsShape.name,
  settings: SourceFieldsShape.settings,
  schemas: SourceFieldsShape.schemas,
  allow_writable_login: SourceFieldsShape.allow_writable_login.optional(),
  timeout_ms: SourceFieldsShape.timeout_ms.optional(),
  row_cap: SourceFieldsShape.row_cap.optional(),
  export_enabled: SourceFieldsShape.export_enabled.optional(),
  export_row_cap: SourceFieldsShape.export_row_cap.optional(),
});

export const ListSourcesQuerySchema = z.strictObject({
  include_archived: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  cursor: z.string().max(512).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

/** A list cursor's values: `created_at` as an ISO string, then the id. */
export const SourceCursorSchema = z.tuple([CursorDateSchema, IdSchema]);
