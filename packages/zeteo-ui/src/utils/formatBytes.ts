const UNITS = ["bytes", "KB", "MB", "GB", "TB"];

/** A size in bytes as "12.3 MB". */
export const formatBytes = (bytes: number): string => {
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const shown = unit === 0 ? String(value) : value.toFixed(value < 10 ? 1 : 0);
  return `${shown} ${UNITS[unit]}`;
};
