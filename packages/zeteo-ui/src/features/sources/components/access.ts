import { isUploadType } from "./sourceLabels";
import type { Source } from "../api/types";
import { useAuth } from "@tereo-io/react";
import type { Me } from "@/lib/auth";

/** The permission that lets a person upload files and own the sources they make. */
export const UPLOADS_WRITE = "zeteo.uploads.write";

/** What a source's pages may do, worked out once by its layout. */
export interface SourceAccess {
  /** An upload's owner (a database source has none). */
  isOwner: boolean;
  /**
   * The header's actions and the catalogue's descriptions; for an upload also
   * its tables, renaming, transfer and deletion: its owner, or a sources admin.
   */
  canManage: boolean;
  /** Limits are a sources admin's only. */
  canSetLimits: boolean;
  /** Who it is shared with: an upload's owner, or whoever may read grants. */
  canSeeSharing: boolean;
  /** Sharing and changing grants: an upload's owner, or a grants admin. */
  canShare: boolean;
  /** Removing grants: as canShare, or a grants admin once it is archived or deleted. */
  canRemoveGrants: boolean;
}

export const useSourceAccess = (source: Source): SourceAccess => {
  const { user, hasPermission } = useAuth<Me>();
  const archived = !!source.archived_at;
  const sourcesAdmin = hasPermission("zeteo.sources.write");
  const grantsAdmin = hasPermission("zeteo.grants.write");
  const grantsReader = hasPermission("zeteo.grants.read");

  if (!isUploadType(source.type)) {
    return {
      isOwner: false,
      canManage: !archived && sourcesAdmin,
      canSetLimits: !archived && sourcesAdmin,
      canSeeSharing: grantsReader,
      canShare: !archived && grantsAdmin,
      // A grant on an archived source can still be removed.
      canRemoveGrants: grantsAdmin,
    };
  }

  const isOwner = !!user && source.owner_id === user.id;
  // The owner acts as the owner while they hold the permission; anyone else
  // needs the admin permission each action's route asks for.
  const asOwner = isOwner && hasPermission(UPLOADS_WRITE);
  const canShare = !archived && (asOwner || grantsAdmin);
  return {
    isOwner,
    canManage: !archived && (asOwner || sourcesAdmin),
    canSetLimits: !archived && sourcesAdmin,
    canSeeSharing: asOwner || grantsAdmin || grantsReader,
    canShare,
    // Once the source is deleted, a grants admin may still remove grants,
    // the former owner's included.
    canRemoveGrants: canShare || (archived && grantsAdmin),
  };
};
