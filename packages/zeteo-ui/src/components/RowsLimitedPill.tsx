import { Badge } from "@kosmeo-ui/react";

/** Shown where figures are only the person's own rows. The reason, when the server gave one, is the tooltip. */
export const RowsLimitedPill = ({ reason }: { reason?: string | null }) => (
  <span
    title={
      reason ??
      "You see only some rows of this data, so figures are yours, not totals."
    }
  >
    <Badge variant="secondary" size="sm">
      Rows limited
    </Badge>
  </span>
);
