import type { z } from "zod";

/**
 * Refuses U+0000, which a Postgres text value cannot hold: unchecked, it
 * reaches the database and fails there as a 500 instead of a 400.
 */
export const noNul = <T extends z.ZodString>(schema: T): T =>
  schema.refine((value) => !value.includes("\u0000"), {
    message: "Must not contain the NUL character",
  }) as T;
