const MAX_BYTES = 63;

function clip(base: string, suffix: string): string {
  const room = MAX_BYTES - suffix.length;
  return base.slice(0, room).replace(/_+$/, "") + suffix;
}

/**
 * A column name from a header: lowercase letters, digits and `_`, starting with a letter, at most
 * 63 bytes. A blank (or all-symbol) header is `column_<index + 1>`; a repeat gets `_2`, `_3`….
 * The result is added to `taken`.
 */
export function normalizeName(
  raw: string,
  taken: Set<string>,
  index: number
): string {
  let base = raw
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (base === "") base = `column_${index + 1}`;
  else if (!/^[a-z]/.test(base)) base = `column_${base}`;
  base = clip(base, "");

  let name = base;
  for (let n = 2; taken.has(name); n += 1) name = clip(base, `_${n}`);
  taken.add(name);
  return name;
}
