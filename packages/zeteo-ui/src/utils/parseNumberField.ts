/** Undefined for an empty field; NaN for anything but digits (reported by the form). */
export const parseNumberField = (text: string): number | undefined => {
  const t = text.trim();
  if (t === "") return undefined;
  return /^\d+$/.test(t) ? Number(t) : NaN;
};
