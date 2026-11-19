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

/**
 * Where a preview's refusal belongs. Its request is `{ measure, bucket }`, so
 * a validation issue's path starts at `measure.`; a plan error's `path` names
 * a field of the measure (`formula`, `where`, `table`) when the draft is at
 * fault. A path into the query the preview runs (`select`, `from`) is not the
 * measure's and stays with the generic notice.
 */
export const previewFieldErrors = (
  error: ApiError | null
): Partial<Record<MeasureField, string>> => {
  if (!error) return {};
  const path = error.path?.map(String);
  return fieldErrors({
    ...error,
    path: path?.[0] === "measure" ? path.slice(1) : path,
    issues: error.issues
      ?.filter((i) => i.path.startsWith("measure."))
      .map((i) => ({ ...i, path: i.path.slice("measure.".length) })),
  });
};
