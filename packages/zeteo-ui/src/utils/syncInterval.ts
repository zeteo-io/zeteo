import { parseNumberField } from "./parseNumberField";

/** A Google Sheets source's "Sync every", in minutes: zeteo's bounds. */
export const MIN_INTERVAL = 15;
export const MAX_INTERVAL = 1440;

/** The problem with a "Sync every" value, or undefined when it is fine. */
export const syncIntervalProblem = (text: string): string | undefined => {
  const n = parseNumberField(text);
  return n === undefined ||
    Number.isNaN(n) ||
    n < MIN_INTERVAL ||
    n > MAX_INTERVAL
    ? `Sync every is ${MIN_INTERVAL} to ${MAX_INTERVAL} minutes.`
    : undefined;
};
