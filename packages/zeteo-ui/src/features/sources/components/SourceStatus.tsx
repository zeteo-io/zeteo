import { isUploadType } from "./sourceLabels";
import type { Source } from "../api/types";
import { Badge } from "@kosmeo-ui/react";

/**
 * A source that is archived reads "Archived", whatever its last status was.
 * An upload has no connection to lose: it is Active until it is deleted. With
 * Google Sheets tables it reads "Stale" once its sync has failed for a day,
 * and "Sync failing" while a table's sync fails (only the owner and
 * `zeteo.sources.read` see this).
 */
export const sourceStatusLabel = (source: Source): string => {
  if (isUploadType(source.type)) {
    if (source.archived_at) return "Deleted";
    if (source.sync?.stale) return "Stale";
    if (source.sync && source.sync.failing.length > 0) return "Sync failing";
    return "Active";
  }
  return source.archived_at
    ? "Archived"
    : source.status === "active"
      ? "Active"
      : "Unreachable";
};

export const SourceStatus = ({ source }: { source: Source }) => {
  const label = sourceStatusLabel(source);
  return (
    <Badge
      size="sm"
      variant={
        source.archived_at
          ? "secondary"
          : label === "Active"
            ? "success"
            : "warning"
      }
    >
      {label}
    </Badge>
  );
};
