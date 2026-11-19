import type { ApiError } from "@/lib/api";

export const MEASURE_FIELDS = [
  "name",
  "description",
  "table",
  "formula",
  "where",
] as const;
export type MeasureField = (typeof MEASURE_FIELDS)[number];

const isField = (key: string): key is MeasureField =>
  (MEASURE_FIELDS as readonly string[]).includes(key);

/**
 * Where the server's refusal belongs: a plan error's `path` (keys and
 * indexes from the measure's root) or a validation issue's dotted path,
 * each put under the field it starts at, with the rest of the path shown.
 */
export const fieldErrors = (
  error: ApiError | null
): Partial<Record<MeasureField, string>> => {
  const out: Partial<Record<MeasureField, string>> = {};
  if (!error) return out;
  if (error.path && error.path.length > 0) {
    const [head, ...rest] = error.path.map(String);
    if (head && isField(head)) {
      out[head] =
        rest.length > 0
          ? `${head}.${rest.join(".")}: ${error.message}`
          : error.message;
    }
  }
  for (const issue of error.issues ?? []) {
    const [head] = issue.path.split(".");
    if (head && isField(head) && !out[head]) {
      out[head] = issue.path.includes(".")
        ? `${issue.path}: ${issue.message}`
        : issue.message;
    }
  }
  return out;
};
