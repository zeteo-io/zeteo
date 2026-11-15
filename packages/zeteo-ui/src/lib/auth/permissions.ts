// The server's ladder, as packages/zeteo/src/utils/permissions.ts implements
// it: the UI must not hide a control from someone the server would allow.

const ADMIN_LEVEL = 5;

const LEVELS = new Map([
  ["read", 1],
  ["write", 2],
  ["archive", 3],
  ["delete", 4],
  ["admin", ADMIN_LEVEL],
]);

/** 0 for an action outside the ladder (`zeteo.data.export`). */
const levelOf = (permission: string): number =>
  LEVELS.get(permission.split(".").pop() ?? "") ?? 0;

/** Everything before the last segment; "" for a one-segment permission. */
const baseOf = (permission: string): string => {
  const parts = permission.split(".");
  return parts.length <= 1 ? "" : parts.slice(0, -1).join(".");
};

const adminCovers = (held: string, wanted: string): boolean => {
  if (levelOf(held) !== ADMIN_LEVEL) return false;
  const heldBase = baseOf(held);
  const wantedBase = baseOf(wanted);
  if (!heldBase) return false;
  return wantedBase === heldBase || wantedBase.startsWith(`${heldBase}.`);
};

const levelCovers = (held: string, wanted: string): boolean => {
  if (baseOf(held) !== baseOf(wanted)) return false;
  const heldLevel = levelOf(held);
  const wantedLevel = levelOf(wanted);
  // An action outside the ladder is granted only by itself or an admin above it.
  if (heldLevel === 0 || wantedLevel === 0) return false;
  return heldLevel >= wantedLevel;
};

/**
 * `admin` covers everything; `x.admin` covers everything under `x.`; within
 * one base read < write < archive < delete < admin; anything off the ladder
 * matches only itself.
 */
export const hasPermission = (held: string[], wanted: string): boolean =>
  held.includes("admin") ||
  held.includes(wanted) ||
  held.some((p) => adminCovers(p, wanted) || levelCovers(p, wanted));
