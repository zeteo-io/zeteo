const SEPARATORS = /^[\s\-–—|:·]+|[\s\-–—|:·]+$/g;

const commonPrefix = (a: string, b: string): string => {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return a.slice(0, i);
};

const commonSuffix = (a: string, b: string): string => {
  let i = 0;
  while (
    i < a.length &&
    i < b.length &&
    a[a.length - 1 - i] === b[b.length - 1 - i]
  ) {
    i++;
  }
  return a.slice(a.length - i);
};

/**
 * A label for each member: its title without the prefix and suffix all the
 * titles share, and without separators left at the edges. A title with nothing
 * left keeps its full title.
 */
export const suggestLabels = (
  members: { tableId: string; title: string }[]
): Record<string, string> => {
  const titles = members.map((m) => m.title);
  let prefix = "";
  let suffix = "";
  if (titles.length > 1) {
    prefix = titles.reduce(commonPrefix);
    suffix = titles.reduce(commonSuffix);
    // Cut only at a word edge, so "Alpha" and "Beta" do not lose their "a".
    const edge = prefix.search(/[^\s\-–—|:·]*$/);
    prefix = prefix.slice(0, edge);
    const first = suffix.search(/[\s\-–—|:·]/);
    suffix = first === -1 ? "" : suffix.slice(first);
  }
  const labels: Record<string, string> = {};
  for (const { tableId, title } of members) {
    const end = Math.max(prefix.length, title.length - suffix.length);
    const rest = title.slice(prefix.length, end).replace(SEPARATORS, "");
    labels[tableId] = rest === "" ? title : rest;
  }
  return labels;
};
