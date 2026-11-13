import type { PrincipalLimit } from "../../prisma/generated/client/index.js";
import { defaultUserLimits, type UserLimits } from "../engine/limits.js";
import type { CallerAccess } from "../grants/access.js";
import { db } from "../utils/db/index.js";

export type { UserLimits };

export type PrincipalLimitRow = Pick<
  PrincipalLimit,
  "principalType" | "principalId" | "queryConcurrency" | "exportConcurrency"
>;

type Field = keyof UserLimits;

/** Per field: the user's own row if it sets one; else the highest among their groups' rows; else the environment default. */
export const resolveUserLimits = (
  rows: PrincipalLimitRow[],
  userId: string,
  groupIds: readonly string[],
  defaults: UserLimits
): UserLimits => {
  const groups = new Set(groupIds);
  const own = rows.find(
    (r) => r.principalType === "user" && r.principalId === userId
  );
  const ofGroups = rows.filter(
    (r) => r.principalType === "group" && groups.has(r.principalId)
  );
  const pick = (field: Field): number => {
    const mine = own?.[field];
    if (mine != null) return mine;
    const set = ofGroups
      .map((r) => r[field])
      .filter((v): v is number => v !== null);
    return set.length > 0 ? Math.max(...set) : defaults[field];
  };
  return {
    queryConcurrency: pick("queryConcurrency"),
    exportConcurrency: pick("exportConcurrency"),
  };
};

/** The caller's limits, read now from the rows of the user and the groups that count for them, in one query. */
export const loadUserLimits = async (
  access: Pick<CallerAccess, "userId" | "groupIds">
): Promise<UserLimits> => {
  const rows = await db.principalLimits.listForPrincipals([
    { type: "user", id: access.userId },
    ...access.groupIds.map((id) => ({ type: "group" as const, id })),
  ]);
  return resolveUserLimits(
    rows,
    access.userId,
    access.groupIds,
    defaultUserLimits()
  );
};
