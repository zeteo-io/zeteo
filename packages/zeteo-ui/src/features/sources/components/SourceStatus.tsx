import type { Source } from "../api/types";
import { Badge } from "@kosmeo-ui/react";

/** A source that is archived reads "Archived", whatever its last status was. */
export const sourceStatusLabel = (source: Source): string =>
  source.archived_at ? "Archived" : source.status;

export const SourceStatus = ({ source }: { source: Source }) => (
  <Badge
    size="sm"
    variant={
      source.archived_at
        ? "secondary"
        : source.status === "active"
          ? "success"
          : "warning"
    }
  >
    {sourceStatusLabel(source)}
  </Badge>
);
