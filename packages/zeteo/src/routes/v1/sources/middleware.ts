import { requireAnyPermission } from "../../../middleware/auth.js";
import {
  UPLOADS_WRITE,
  SOURCES_READ,
  SOURCES_WRITE,
} from "../../../definitions/tereoDeclaration.js";

/**
 * Listing: an admin's `zeteo.sources.read`, or an owner's
 * `zeteo.uploads.write` (their own, with `owner_id=me`; the controller
 * decides).
 */
export const requireListing = requireAnyPermission([
  SOURCES_READ,
  UPLOADS_WRITE,
]);

/**
 * Creating, before the body is read: `zeteo.sources.write` for a database
 * source, `zeteo.uploads.write` for an upload one (the controller
 * decides by the body's `type`).
 */
export const requireCreating = requireAnyPermission([
  SOURCES_WRITE,
  UPLOADS_WRITE,
]);
