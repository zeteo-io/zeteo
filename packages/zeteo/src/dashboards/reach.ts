import type { SavedQuery } from "../../prisma/generated/client/index.js";

/**
 * The reach rule: whether a panel (or saved panel) owned by `panelOwnerId`
 * may use the saved query for a viewer signed in to `viewerOrganizationId`.
 * Always when the panel's owner owns the saved query; otherwise only while
 * its "Available for dashboards" toggle is on and the viewer is signed in to
 * the organization it was made available in (null matches null).
 */
export const reaches = ({
  savedQuery,
  panelOwnerId,
  viewerOrganizationId,
}: {
  savedQuery: Pick<
    SavedQuery,
    "ownerId" | "availableForDashboards" | "availableOrganizationId"
  >;
  panelOwnerId: string;
  viewerOrganizationId: string | null;
}): boolean =>
  savedQuery.ownerId === panelOwnerId ||
  (savedQuery.availableForDashboards &&
    savedQuery.availableOrganizationId === viewerOrganizationId);
