import { issuesOf, ValidationError } from "./errors.js";
import { ZodSchema, z, type ZodError } from "zod";
import type { Request } from "express";

export { MAX_ISSUE_CHARS, MAX_ISSUES, truncate } from "./errors.js";

/** The 400 for a request part that failed `error`'s checks: up to `MAX_ISSUES` issues, and how many more there were. */
export const invalidRequest = (
  what: string,
  error: ZodError
): ValidationError => {
  const issues = issuesOf(error);
  const more = error.issues.length - issues.length;
  const listed = issues.map((i) => `${i.path}: ${i.message}`).join(", ");
  return new ValidationError(
    `Invalid request ${what}. ${listed}${more > 0 ? `, and ${more} more` : ""}`,
    issues
  );
};

export const validateParams = <T extends ZodSchema>(
  schema: T,
  req: Request
): z.infer<T> => {
  const result = schema.safeParse(req.params);
  if (!result.success) throw invalidRequest("params", result.error);
  return result.data;
};

export const validateQuery = <T extends ZodSchema>(
  schema: T,
  req: Request
): z.infer<T> => {
  const result = schema.safeParse(req.query);
  if (!result.success) throw invalidRequest("query", result.error);
  return result.data;
};

export const validateBody = <T extends ZodSchema>(
  schema: T,
  req: Request
): z.infer<T> => {
  const result = schema.safeParse(req.body);
  if (!result.success) throw invalidRequest("body", result.error);
  return result.data;
};

/** Header names arrive lowercased: key the schema by `"x-metadata"`, not `"X-Metadata"`. */
export const validateHeaders = <T extends ZodSchema>(
  schema: T,
  req: Request
): z.infer<T> => {
  const result = schema.safeParse(req.headers);
  if (!result.success) throw invalidRequest("headers", result.error);
  return result.data;
};
