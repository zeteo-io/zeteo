/** One warning naming every column with no values in a preview's first rows; null when there is none. */
export const emptyColumnsWarning = (names: string[]): string | null => {
  if (names.length === 0) return null;
  const quoted = names.map((n) => `"${n}"`);
  return names.length === 1
    ? `Column ${quoted[0]} has no values in its first rows.`
    : `Columns ${quoted.join(", ")} have no values in their first rows.`;
};
