import { toApiError, useZeteoApi, type ApiError } from "@/lib/api";
import type { PrincipalRef } from "@/features/principals";
import { ErrorNotice } from "@/components/ErrorNotice";
import { Alert, Button } from "@kosmeo-ui/react";
import { useQuery } from "@tanstack/react-query";
import type { Grant } from "../api/types";

interface ExistingGrantNoticeProps {
  principal: PrincipalRef;
  sourceId: string;
  tableId: string;
  /** The `409 grant_exists` that asked for this. */
  error: ApiError;
  /** Opens the grant that is already there, to change it instead. */
  onEdit: (grant: Grant) => void;
}

/** Points at the grant that already covers this principal and table, when it can be found. */
export const ExistingGrantNotice = ({
  principal,
  sourceId,
  tableId,
  error,
  onEdit,
}: ExistingGrantNoticeProps) => {
  const api = useZeteoApi();
  const existing = useQuery({
    queryKey: ["grants", "existing", principal.type, principal.id, tableId],
    queryFn: async () => {
      try {
        // With the source, an upload's owner may ask too.
        const res = await api.get<{ data: Grant[] }>("/v1/grants", {
          params: {
            source_id: sourceId,
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
    const grant = existing.data;
    return (
      <Alert variant="warning">
        <p>They already have access to this table.</p>
        <Button
          size="sm"
          variant="secondary"
          fullWidth={false}
          onClick={() => onEdit(grant)}
        >
          Edit that grant
        </Button>
      </Alert>
    );
  }
  // Still looking, or nothing to point at: say what the API said.
  return existing.isLoading ? null : <ErrorNotice error={error} />;
};
