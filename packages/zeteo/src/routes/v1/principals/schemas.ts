import { PrincipalTypeSchema } from "../grants/schemas.js";
import { z } from "zod";

export const SearchPrincipalsQuerySchema = z.strictObject({
  type: PrincipalTypeSchema,
  q: z.string().min(2).max(100),
  limit: z.coerce.number().int().min(1).max(25).default(10),
});
