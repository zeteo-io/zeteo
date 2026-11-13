import type { RowStream } from "./types.js";

/** A RowStream over rows already in memory; `close` calls `onClose` once. */
export const bufferedStream = (
  columns: RowStream["columns"],
  rows: unknown[][],
  onClose?: () => Promise<void>
): RowStream => {
  let at = 0;
  let closing: Promise<void> | undefined;
  return {
    columns,
    next: async (maxRows) => {
      if (!(maxRows >= 1)) throw new Error(`invalid batch size: ${maxRows}`);
      const batch = rows.slice(at, at + maxRows);
      at += batch.length;
      return batch;
    },
    close: () =>
      (closing ??= Promise.resolve()
        .then(() => onClose?.())
        .catch(() => undefined)),
  };
};
