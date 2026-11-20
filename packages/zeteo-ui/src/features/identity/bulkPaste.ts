/** One pasted line: an email and the value it stands for, split at the first tab or comma. */
export interface PastedLine {
  line: string;
  email: string;
  value: string;
}

/** `email<TAB or comma>value` lines; a line with no value, or no email, comes back as bad. */
export const parsePasted = (
  text: string
): { lines: PastedLine[]; bad: string[] } => {
  const lines: PastedLine[] = [];
  const bad: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim()) continue;
    const cut = raw.search(/[\t,]/);
    const email = (cut < 0 ? raw : raw.slice(0, cut)).trim();
    const value = cut < 0 ? "" : raw.slice(cut + 1).trim();
    if (!email.includes("@") || !value || value.length > 500)
      bad.push(raw.trim());
    else lines.push({ line: raw.trim(), email, value });
  }
  return { lines, bad };
};
