const READ = ".read";

/** `admin` covers everything and `x.write` covers `x.read`; otherwise an exact match. */
export const hasPermission = (held: string[], wanted: string): boolean => {
  if (held.includes("admin") || held.includes(wanted)) return true;
  return (
    wanted.endsWith(READ) &&
    held.includes(`${wanted.slice(0, -READ.length)}.write`)
  );
};
