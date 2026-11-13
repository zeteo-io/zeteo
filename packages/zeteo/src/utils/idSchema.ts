import { z } from "zod";

/** `z.guid()` accepts upper case; lower-casing keeps one id from being two in comparisons, sets and keys. */
export const IdSchema = z.guid().transform((s) => s.toLowerCase());
