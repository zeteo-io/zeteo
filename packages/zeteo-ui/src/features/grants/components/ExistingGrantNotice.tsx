import { api, toApiError, type ApiError } from "@/lib/api";
import type { PrincipalRef } from "@/features/principals";
import { ErrorNotice } from "@/components/ErrorNotice";
import { useQuery } from "@tanstack/react-query";
import type { Grant } from "../api/types";
import { Alert } from "@kosmeo-ui/react";
import { Link } from "react-router-dom";

interface ExistingGrantNoticeProps {
  principal: PrincipalRef;
  tableId: string;
  /** The `409 grant_exists` that asked for this. */
  error: ApiError;
}

/** Points at the grant that already covers this principal and table, when it can be found. */
export const ExistingGrantNotice = ({
  principal,
  tableId,
  error,
}: ExistingGrantNoticeProps) => {
  const existing = useQuery({
    queryKey: ["grants", "existing", principal.type, principal.id, tableId],
    queryFn: async () => {
      try {
        const res = await api.get<{ data: Grant[] }>("/v1/grants", {
          params: {
            principal_type: principal.type,
            principal_id: principal.id,
            table_id: tableId,
            limit: 1,
          },
        });
        return res.data.data[0] ?? null;
      } catch (err) {
        throw toApiError(err);
      }
    },
  });

  if (existing.data) {
    return (
      <Alert variant="warning">
        <p>This principal already has a grant on this table</p>
        <Link to={`/grants/${existing.data.id}/edit`}>Edit that grant</Link>
      </Alert>
    );
  }
  // Still looking, or nothing to point at: say what the API said.
  return existing.isLoading ? null : <ErrorNotice error={error} />;
};
