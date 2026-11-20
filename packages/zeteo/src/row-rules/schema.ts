import { z } from "zod";
import {
  identityRefSchema,
  makeFilterSchema,
} from "../adapters/sql/language.js";

/** A row rule as written in the API: the query language's `where`, plus identity references; keys are column names. */
export const RowRuleInputSchema = makeFilterSchema({ identity: true });

export const IdentityRefSchema = identityRefSchema;

export { IDENTITY_KEY_NAME } from "../adapters/sql/language.js";

export const RowAccessSchema = z.enum(["unlimited_default", "all", "rule"]);
