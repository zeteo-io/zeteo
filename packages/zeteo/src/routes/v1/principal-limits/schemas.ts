import { PrincipalTypeSchema } from "../grants/schemas.js";
import { IdSchema } from "../../../utils/idSchema.js";
import { z } from "zod";

/** How many queries one principal may run at once. */
export const QueryConcurrencySchema = z.number().int().min(1).max(100);

/** How many exports one principal may run at once. */
export const ExportConcurrencySchema = z.number().int().min(1).max(10);

export const CreatePrincipalLimitSchema = z
  .strictObject({
    principal_type: PrincipalTypeSchema,
    principal_id: IdSchema,
    query_concurrency: QueryConcurrencySchema.optional(),
    export_concurrency: ExportConcurrencySchema.optional(),
  })
  .refine(
    (body) =>
      body.query_concurrency !== undefined ||
      body.export_concurrency !== undefined,
    { message: "Give query_concurrency, export_concurrency or both" }
  );

export const ListPrincipalLimitsQuerySchema = z.strictObject({
  principal_type: PrincipalTypeSchema.optional(),
  principal_id: IdSchema.optional(),
  cursor: z.string().max(512).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

/** A list cursor's values: the row's id (ids are time-ordered). */
export const PrincipalLimitCursorSchema = z.tuple([IdSchema]);
