import type { LimitFilters, PrincipalLimit } from "../api/types";
import { faTrash } from "@fortawesome/free-solid-svg-icons";
import { ConfirmButton } from "@/components/ConfirmButton";
import { ErrorNotice } from "@/components/ErrorNotice";
import { useDeleteLimit } from "../api/useDeleteLimit";
import { PageHeader } from "@/components/PageHeader";
import { EditButton } from "@/components/EditButton";
import { useEffect, useMemo, useState } from "react";
import { FilterChip } from "@/components/FilterChip";
import { useUrlFilters } from "@/lib/useUrlFilters";
import { useLimits } from "../api/useLimits";
import { useAuth } from "@tereo-io/react";
import { LimitForm } from "./LimitForm";
import "./styles.css";
import {
  PrincipalCell,
  PrincipalLabel,
  parseWho,
  useDirectory,
  usePrincipalNames,
  whoFilter,
  whoId,
  type PrincipalRef,
} from "@/features/principals";
import {
  Button,
  EmptyState,
  RowActions,
  Spinner,
  Table,
  TableFilters,
} from "@kosmeo-ui/react";

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

const value = (n: number | null) =>
  n === null ? <span className="z-muted">Default</span> : n;

const DeleteLimit = ({ limit }: { limit: PrincipalLimit }) => {
  const del = useDeleteLimit();
  const ref = { type: limit.principal_type, id: limit.principal_id };
  const { get } = usePrincipalNames([ref]);
  const name = get(ref)?.name ?? limit.principal_id;
  return (
    <ConfirmButton
      danger
      size="sm"
      icon={faTrash}
      label="Delete"
      confirmTitle="Delete this limit?"
      confirmText={`${name} falls back to its groups' limits or the defaults for runs that start after this.`}
      confirmLabel="Delete limit"
      onConfirm={() => del.mutateAsync(limit.id)}
    />
  );
};

export const LimitsPage = () => {
  const { hasPermission } = useAuth();
  const [filters, setFilters] = useUrlFilters(
    ["principal_type", "principal_id"],
    filtersOf
  );
  const { items, isLoading, error, hasMore, loadMore } = useLimits(filters);
  const directory = useDirectory("admin");
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<PrincipalLimit | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  useEffect(() => setLoadingMore(false), [items.length, hasMore, error]);

  const canWrite = hasPermission("zeteo.grants.write");
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

  const selectedWho = principal ? whoId(principal.type, principal.id) : "";
  // TableFilters starts over when its definitions change: they change only
  // with the directory and the choice, and it waits for the directory.
  const filterDefs = useMemo(
    () =>
      directory.data
        ? [whoFilter(directory.data.data, { selected: selectedWho })]
        : [],
    [directory.data, selectedWho]
  );
  const onFiltersChange = (params: Record<string, string>) => {
    const who = parseWho(params);
    if (who.principal_id !== filters.principal_id) {
      filterTo(
        who.principal_type && who.principal_id
          ? { type: who.principal_type, id: who.principal_id }
          : null
      );
    }
  };

  return (
    <>
      <PageHeader title="Limits" divider={false} />
      <div className="z-list-toolbar z-list-toolbar-top">
        <div className="z-list-toolbar-filters z-limits-toolbar">
          {directory.data && (
            <TableFilters filters={filterDefs} onChange={onFiltersChange} />
          )}
          {/* Without the directory, a principal from the address is a chip. */}
          {principal && directory.isError && (
            <FilterChip
              clearLabel="Clear person or group"
              onClear={() => filterTo(null)}
            >
              <PrincipalLabel refValue={principal} />
            </FilterChip>
          )}
        </div>
        {canWrite && (
          <Button size="sm" fullWidth={false} onClick={() => setCreating(true)}>
            New limit
          </Button>
        )}
      </div>
      <ErrorNotice error={directory.error} />
      <ErrorNotice error={error} />
      {isLoading ? (
        <Spinner size="lg" />
      ) : (
        <div className={canWrite ? "z-actions-last" : undefined}>
          <Table<PrincipalLimit>
            rowKey={(limit) => limit.id}
            emptyMessage={
              error ? undefined : (
                <EmptyState>
                  {principal
                    ? "This person or group has no limit of its own."
                    : "No limits yet. Without one, a person's queries and exports are held only by each source's own limits. Add a limit to cap how many a person or group can run at once."}
                </EmptyState>
              )
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
                title: "Queries at once",
                cellElement: (limit) => value(limit.query_concurrency),
              },
              {
                title: "Exports at once",
                cellElement: (limit) => value(limit.export_concurrency),
              },
              ...(canWrite
                ? [
                    {
                      title: "",
                      cellElement: (limit: PrincipalLimit) => (
                        <RowActions align="end">
                          <EditButton onClick={() => setEditing(limit)} />
                          <DeleteLimit limit={limit} />
                        </RowActions>
                      ),
                    },
                  ]
                : []),
            ]}
            rows={items}
          />
        </div>
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
