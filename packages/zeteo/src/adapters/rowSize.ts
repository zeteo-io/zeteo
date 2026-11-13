/** What a value that is not text counts for: about the most its JSON or CSV form takes. */
const SCALAR_BYTES = 8;

/**
 * About how many bytes a normalised row takes once written: a string counts
 * its length, a parsed JSON value the length of its text, anything else
 * `SCALAR_BYTES`; plus one per value for its separator. Cheap enough to run
 * on every row: no encoding, and JSON only for values that are JSON.
 */
export const approxRowBytes = (row: readonly unknown[]): number => {
  let bytes = 1;
  for (const value of row) {
    bytes += 1;
    if (typeof value === "string") bytes += value.length;
    else if (typeof value === "object" && value !== null) {
      bytes += JSON.stringify(value).length;
    } else bytes += SCALAR_BYTES;
  }
  return bytes;
};
