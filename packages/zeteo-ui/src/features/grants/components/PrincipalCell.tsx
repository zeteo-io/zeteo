import { usePrincipalNames } from "@/features/principals";
import type { Grant } from "../api/types";
import { Badge } from "@kosmeo-ui/react";

interface PrincipalCellProps {
  grant: Pick<Grant, "principal_type" | "principal_id" | "principal_status">;
}

/**
 * Who a grant is for. The name comes from the batched lookup. At most one
 * status badge: the grant's own `orphaned`, else its `unknown`, else the
 * lookup's `inactive`. A failed or contrary lookup never adds a badge.
 */
export const PrincipalCell = ({ grant }: PrincipalCellProps) => {
  const ref = { type: grant.principal_type, id: grant.principal_id };
  const { get, unavailable } = usePrincipalNames([ref]);
  const principal = get(ref);

  const badge =
    grant.principal_status === "orphaned"
      ? { text: "Orphaned", variant: "warning" as const }
      : grant.principal_status === "unknown"
        ? { text: "Unknown", variant: "secondary" as const }
        : principal?.status === "inactive"
          ? { text: "Inactive", variant: "secondary" as const }
          : null;

  return (
    <span>
      {principal?.name ? <span>{principal.name}</span> : <code>{ref.id}</code>}
      {principal?.email && <small> {principal.email}</small>}
      <small> {ref.type}</small>
      {!principal && unavailable && <small> name unavailable</small>}
      {badge && (
        <>
          {" "}
          <Badge variant={badge.variant} size="sm">
            {badge.text}
          </Badge>
        </>
      )}
    </span>
  );
};
