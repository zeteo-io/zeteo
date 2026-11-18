import { requireAnyPermission } from "../../../middleware/auth.js";
import {
  FILE_SOURCES_WRITE,
  SOURCES_READ,
  SOURCES_WRITE,
} from "../../../definitions/tereoDeclaration.js";

/**
 * Listing: an admin's `zeteo.sources.read`, or an owner's
 * `zeteo.file_sources.write` (their own, with `owner_id=me`; the controller
 * decides).
 */
export const requireListing = requireAnyPermission([
  SOURCES_READ,
  FILE_SOURCES_WRITE,
]);

/**
 * Creating, before the body is read: `zeteo.sources.write` for a database
 * source, `zeteo.file_sources.write` for an upload one (the controller
 * decides by the body's `type`).
 */
export const requireCreating = requireAnyPermission([
  SOURCES_WRITE,
  FILE_SOURCES_WRITE,
]);
