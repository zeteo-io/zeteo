import { Button, EmptyState, Spinner, Table } from "@kosmeo-ui/react";
import type { LimitFilters, PrincipalLimit } from "../api/types";
import { ConfirmButton } from "@/components/ConfirmButton";
import { ErrorNotice } from "@/components/ErrorNotice";
import { useDeleteLimit } from "../api/useDeleteLimit";
import { PageHeader } from "@/components/PageHeader";
import { useUrlFilters } from "@/lib/useUrlFilters";
import { useLimits } from "../api/useLimits";
import { useEffect, useState } from "react";
import { LimitForm } from "./LimitForm";
import { useAuth } from "@/lib/auth";
import "./styles.css";
import {
  PrincipalCell,
  PrincipalLabel,
  PrincipalPicker,
  usePrincipalNames,
  type PrincipalRef,
} from "@/features/principals";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The principal filter only counts as a complete, valid pair. */
const filtersOf = (params: URLSearchParams): LimitFilters => {
  const type = params.get("principal_type");
  const id = params.get("principal_id");
  const valid =
    (type === "user" || type === "group") && id !== null && UUID.test(id);
  return valid
    ? { principal_type: type, principal_id: id.toLowerCase() }
    : { principal_type: undefined, principal_id: undefined };
};

const value = (n: number | null) => (n === null ? <em>Default</em> : n);

const DeleteLimit = ({ limit }: { limit: PrincipalLimit }) => {
  const del = useDeleteLimit();
  const ref = { type: limit.principal_type, id: limit.principal_id };
  const { get } = usePrincipalNames([ref]);
  const name = get(ref)?.name ?? limit.principal_id;
  return (
    <ConfirmButton
      danger
      label="Delete"
      confirmTitle="Delete this limit?"
      confirmText={`${name} falls back to its groups' limits or the defaults for runs that start after this.`}
      confirmLabel="Delete limit"
      onConfirm={() => del.mutateAsync(limit.id)}
    />
  );
};

export const LimitsPage = () => {
  const { can } = useAuth();
  const [filters, setFilters] = useUrlFilters(
    ["principal_type", "principal_id"],
    filtersOf
  );
  const { items, isLoading, error, hasMore, loadMore } = useLimits(filters);
  const [pickingPrincipal, setPickingPrincipal] = useState(false);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<PrincipalLimit | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  useEffect(() => setLoadingMore(false), [items.length, hasMore, error]);

  const canWrite = can("zeteo.grants.write");
  const principal: PrincipalRef | null =
    filters.principal_type && filters.principal_id
      ? { type: filters.principal_type, id: filters.principal_id }
      : null;

  const filterTo = (next: PrincipalRef | null) =>
    setFilters(
      next
        ? { principal_type: next.type, principal_id: next.id }
        : { principal_type: undefined, principal_id: undefined }
    );

  return (
    <>
      <PageHeader
        title="Limits"
        subtitle="How many queries and exports each user and group may run at once"
        actions={
          canWrite && (
            <Button fullWidth={false} onClick={() => setCreating(true)}>
              New limit
            </Button>
          )
        }
      />
      <div className="z-limits-filter">
        {principal && (
          <p>
            Principal: <PrincipalLabel refValue={principal} />{" "}
            <Button
              size="sm"
              variant="secondary"
              fullWidth={false}
              onClick={() => filterTo(null)}
            >
              Clear principal
            </Button>
          </p>
        )}
        <Button
          size="sm"
          variant="secondary"
          fullWidth={false}
          aria-expanded={pickingPrincipal}
          onClick={() => setPickingPrincipal((open) => !open)}
        >
          {pickingPrincipal ? "Hide principal filter" : "Filter by principal"}
        </Button>
        {pickingPrincipal && (
          <PrincipalPicker value={principal} onChange={filterTo} />
        )}
      </div>
      <ErrorNotice error={error} />
      {isLoading ? (
        <Spinner size="lg" />
      ) : (
        <Table<PrincipalLimit>
          rowKey={(limit) => limit.id}
          emptyMessage={
            error ? undefined : <EmptyState>No limits yet.</EmptyState>
          }
          columns={[
            {
              title: "Principal",
              cellElement: (limit) => (
                <PrincipalCell
                  principal_type={limit.principal_type}
                  principal_id={limit.principal_id}
                  status={limit.principal_status}
                />
              ),
            },
            {
              title: "Query concurrency",
              cellElement: (limit) => value(limit.query_concurrency),
            },
            {
              title: "Export concurrency",
              cellElement: (limit) => value(limit.export_concurrency),
            },
            ...(canWrite
              ? [
                  {
                    title: "",
                    cellElement: (limit: PrincipalLimit) => (
                      <div className="z-limits-actions">
                        <Button
                          variant="secondary"
                          fullWidth={false}
                          onClick={() => setEditing(limit)}
                        >
                          Edit
                        </Button>
                        <DeleteLimit limit={limit} />
                      </div>
                    ),
                  },
                ]
              : []),
          ]}
          rows={items}
        />
      )}
      {hasMore && (
        <div className="z-limits-more">
          <Button
            variant="secondary"
            fullWidth={false}
            isLoading={loadingMore}
            disabled={loadingMore}
            onClick={() => {
              setLoadingMore(true);
              loadMore();
            }}
          >
            Load more
          </Button>
        </div>
      )}
      {canWrite && creating && (
        <LimitForm onClose={() => setCreating(false)} onConflict={filterTo} />
      )}
      {canWrite && editing && (
        <LimitForm
          key={editing.id}
          limit={editing}
          onClose={() => setEditing(null)}
        />
      )}
    </>
  );
};
