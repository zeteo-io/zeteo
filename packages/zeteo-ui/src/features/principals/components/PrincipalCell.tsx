import { faUser, faUserGroup } from "@fortawesome/free-solid-svg-icons";
import type { PrincipalStatus, PrincipalType } from "../api/types";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { usePrincipalNames } from "../api/usePrincipalNames";
import { Badge } from "@kosmeo-ui/react";

interface PrincipalCellProps {
  principal_type: PrincipalType;
  principal_id: string;
  /** The row's own `principal_status`. */
  status: PrincipalStatus;
}

/**
 * Who a row is for. The name comes from the batched lookup. At most one
 * status badge: the row's own `orphaned`, else its `unknown`, else the
 * lookup's `inactive`. A failed or contrary lookup never adds a badge.
 */
export const PrincipalCell = ({
  principal_type,
  principal_id,
  status,
}: PrincipalCellProps) => {
  const ref = { type: principal_type, id: principal_id };
  const { get, unavailable } = usePrincipalNames([ref]);
  const principal = get(ref);

  const badge =
    status === "orphaned"
      ? { text: "Orphaned", variant: "warning" as const }
      : status === "unknown"
        ? { text: "Unknown", variant: "secondary" as const }
        : principal?.status === "inactive"
          ? { text: "Inactive", variant: "secondary" as const }
          : null;

  return (
    <span className="z-principal-cell">
      <FontAwesomeIcon
        icon={ref.type === "group" ? faUserGroup : faUser}
        className="z-principal-icon"
        title={ref.type === "group" ? "Group" : "User"}
      />
      {principal?.name ? <span>{principal.name}</span> : <code>{ref.id}</code>}
      {principal?.email && (
        <span className="z-principal-email">{principal.email}</span>
      )}
      {!principal && unavailable && (
        <span className="z-principal-email">name unavailable</span>
      )}
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
