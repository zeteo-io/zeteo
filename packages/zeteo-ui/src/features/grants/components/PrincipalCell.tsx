import { usePrincipalNames } from "@/features/principals";
import type { Grant } from "../api/types";
import { Badge } from "@kosmeo-ui/react";

interface PrincipalCellProps {
  grant: Pick<Grant, "principal_type" | "principal_id" | "principal_status">;
}

/**
 * Who a grant is for. The name comes from the batched lookup; the badge from
 * the grant's own `principal_status`, or from the lookup when it finds the
 * principal gone. A failed lookup only costs the name: it never adds a badge.
 */
export const PrincipalCell = ({ grant }: PrincipalCellProps) => {
  const ref = { type: grant.principal_type, id: grant.principal_id };
  const { get, unavailable } = usePrincipalNames([ref]);
  const principal = get(ref);
  const kind = <small> {grant.principal_type}</small>;

  if (
    grant.principal_status === "orphaned" ||
    principal?.status === "orphaned"
  ) {
    return (
      <span>
        <code>{ref.id}</code>
        {kind}{" "}
        <Badge variant="warning" size="sm">
          Orphaned
        </Badge>
      </span>
    );
  }
  return (
    <span>
      {principal ? (
        <span>{principal.name ?? <code>{ref.id}</code>}</span>
      ) : (
        <code>{ref.id}</code>
      )}
      {principal?.email && <small> {principal.email}</small>}
      {kind}
      {!principal && unavailable && <small> name unavailable</small>}
      {principal?.status === "inactive" && (
        <>
          {" "}
          <Badge variant="secondary" size="sm">
            Inactive
          </Badge>
        </>
      )}
      {grant.principal_status === "unknown" && (
        <>
          {" "}
          <Badge variant="secondary" size="sm">
            Unknown
          </Badge>
        </>
      )}
    </span>
  );
};
