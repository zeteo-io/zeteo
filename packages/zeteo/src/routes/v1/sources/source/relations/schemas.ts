import { IdSchema } from "../../../../../utils/idSchema.js";
import { z } from "zod";

/** The database's own limit on a relation name, and the shape the query language will use. */
export const RELATION_NAME_PATTERN = /^[a-z][a-z0-9_]{0,62}$/;

export const RelationParamsSchema = z.object({
  sourceId: IdSchema,
  relationId: IdSchema,
});

export const ListRelationsQuerySchema = z.strictObject({
  cursor: z.string().max(512).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

/** A list cursor's values: the relation's id. */
export const RelationCursorSchema = z.tuple([IdSchema]);

const Columns = z.array(z.string().min(1).max(128)).min(1).max(32);

export const DeclareRelationSchema = z.strictObject({
  name: z.string().regex(RELATION_NAME_PATTERN, {
    message:
      "A relation name is lower case letters, digits and underscores, starting with a letter, 1 to 63 characters",
  }),
  from_table_id: IdSchema,
  from_columns: Columns,
  to_table_id: IdSchema,
  to_columns: Columns,
  to_many: z.boolean(),
});
