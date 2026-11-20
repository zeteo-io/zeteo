import type { Source } from "../../prisma/generated/client/index.js";
import { ownsUploadSource } from "../uploads/ownership.js";
import { hasPermission } from "../utils/permissions.js";
import { groupIdsOf } from "../grants/principals.js";
import type { Caller } from "../middleware/auth.js";
import { db } from "../utils/db/index.js";
import {
  MEASURES_WRITE,
  SOURCES_READ,
  SOURCES_WRITE,
} from "../definitions/tereoDeclaration.js";

// Who may do what with a source's measures. Changing them takes
// `zeteo.measures.write` and being an editor of the source: listed, as a
// user or through a group, or the owner of an upload source. Who is listed
// is managed by `zeteo.sources.write` holders and an upload source's owner.

type SourceOwnership = Pick<Source, "id" | "type" | "ownerId">;

/**
 * Whether the caller may create, change and delete the source's measures:
 * `zeteo.measures.write`, and listed as an editor (themselves or one of the
 * groups that count for them) or the owner of the upload source. Asks tereo
 * for the caller's groups: never inside a transaction.
 */
export const isMeasureEditor = async (
  caller: Caller,
  source: SourceOwnership
): Promise<boolean> => {
  if (!hasPermission(caller.permissions, MEASURES_WRITE)) return false;
  if (ownsUploadSource(caller, source)) return true;
  const editors = await db.measures.listEditors(source.id);
  if (
    editors.some(
      (e) => e.principalType === "user" && e.principalId === caller.userId
    )
  ) {
    return true;
  }
  const listedGroups = editors.filter((e) => e.principalType === "group");
  if (listedGroups.length === 0) return false;
  const groups = new Set(await groupIdsOf(caller));
  return listedGroups.some((e) => groups.has(e.principalId));
};

/** Whether the caller may change who the source's editors are: `zeteo.sources.write`, or the upload source's owner. */
export const mayManageEditors = (
  caller: Caller,
  source: SourceOwnership
): boolean =>
  hasPermission(caller.permissions, SOURCES_WRITE) ||
  ownsUploadSource(caller, source);

/** Whether the caller sees every measure of the source in full: `zeteo.sources.read`, or the upload source's owner. */
export const seesAllMeasures = (
  caller: Caller,
  source: SourceOwnership
): boolean =>
  hasPermission(caller.permissions, SOURCES_READ) ||
  ownsUploadSource(caller, source);
