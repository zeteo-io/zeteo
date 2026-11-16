import { faTrash, faUser } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { tableLabel, useAllTables } from "@/features/tables";
import { GrantDeleteButton } from "./GrantDeleteButton";
import type { Grant, GrantFilters } from "../api/types";
import { ErrorNotice } from "@/components/ErrorNotice";
import { FilterChip } from "@/components/FilterChip";
import { Link, useNavigate } from "react-router-dom";
import { PageHeader } from "@/components/PageHeader";
import { EditButton } from "@/components/EditButton";
import { useUrlFilters } from "@/lib/useUrlFilters";
import { useAllSources } from "@/features/sources";
import { useGrants } from "../api/useGrants";
import { useEffect, useState } from "react";
import { useAuth } from "@tereo-io/react";
import "./styles.css";
import {
  PrincipalCell,
  PrincipalLabel,
  PrincipalPicker,
  type PrincipalRef,
} from "@/features/principals";
import {
  Alert,
  Badge,
  Button,
  EmptyState,
  Modal,
  RowActions,
  Spinner,
  Table,
  TableFilters,
  type InfiniteScrollMenuFilter,
} from "@kosmeo-ui/react";

const columnsText = (grant: Grant) =>
  grant.all_columns
    ? "All columns"
    : `${grant.columns.length} ${grant.columns.length === 1 ? "column" : "columns"}`;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuidParam = (params: URLSearchParams, key: string) => {
  const value = params.get(key);
  return value && UUID.test(value) ? value.toLowerCase() : undefined;
};

/** The filters the address asks for, minus anything invalid or half a principal. */
const filtersOf = (params: URLSearchParams): GrantFilters => {
  const type = params.get("principal_type");
  const principalId = uuidParam(params, "principal_id");
  const principalType = type === "user" || type === "group" ? type : undefined;
  const pair = principalType && principalId;
  return {
    source_id: uuidParam(params, "source_id"),
    table_id: uuidParam(params, "table_id"),
    principal_type: pair ? principalType : undefined,
    principal_id: pair ? principalId : undefined,
  };
};

export const GrantsPage = () => {
  const { hasPermission } = useAuth();
  const navigate = useNavigate();
  const [filters, setFilters] = useUrlFilters(
    ["source_id", "table_id", "principal_type", "principal_id"],
    filtersOf
  );
  const canReadSources = hasPermission("zeteo.sources.read");
  const { items, isLoading, error, hasMore, loadMore } = useGrants(filters);
  const sources = useAllSources(canReadSources);
  const tables = useAllTables(canReadSources ? filters.source_id : undefined);
  const [pickingPrincipal, setPickingPrincipal] = useState(false);

  const [loadingMore, setLoadingMore] = useState(false);
  useEffect(() => setLoadingMore(false), [items.length, hasMore, error]);

  const principal: PrincipalRef | null =
    filters.principal_type && filters.principal_id
      ? { type: filters.principal_type, id: filters.principal_id }
      : null;
  const anyFilter = !!(filters.source_id || filters.table_id || principal);
  const selectsUnavailable = !canReadSources || sources.error?.status === 403;
  const canWrite = hasPermission("zeteo.grants.write");

  // A filter the selects cannot show (no Read sources, or a table from the
  // address without its source) is a chip, named from what is known.
  const sourceChip =
    filters.source_id && selectsUnavailable
      ? (items.find((g) => g.source.id === filters.source_id)?.source.slug ??
        filters.source_id)
      : null;
  const tableChip =
    filters.table_id && (selectsUnavailable || !filters.source_id)
      ? (() => {
          const known = items.find((g) => g.table.id === filters.table_id);
          return known ? tableLabel(known.table) : filters.table_id;
        })()
      : null;

  const clearPrincipal = () =>
    setFilters({
      ...filters,
      principal_type: undefined,
      principal_id: undefined,
    });

  // The current choices go into the definitions, so TableFilters, which
  // starts over whenever they change, starts over where it already was.
  const filterDefs: InfiniteScrollMenuFilter[] = [
    {
      type: "SELECT",
      title: "Source",
      dataKey: "source_id",
      options: sources.sources.map((s) => ({
        id: s.id,
        name: `${s.name}${s.archived_at ? " (archived)" : ""}`,
        selected: s.id === filters.source_id,
      })),
    },
    ...(filters.source_id
      ? [
          {
            type: "SELECT" as const,
            title: "Table",
            dataKey: "table_id",
            options: tables.tables.map((t) => ({
              id: t.id,
              name: `${tableLabel(t)}${t.missing_since ? " (missing)" : ""}`,
              selected: t.id === filters.table_id,
            })),
          },
        ]
      : []),
  ];

  // TableFilters reports its choices as soon as it mounts, so it waits for the
  // options that hold the current choices; otherwise it would report them gone.
  const filtersReady =
    !selectsUnavailable &&
    !sources.isLoading &&
    !(filters.source_id && tables.isLoading);

  const onFiltersChange = (params: Record<string, string>) => {
    const source_id = params["filter[source_id]"] || undefined;
    // A table belongs to one source: changing the source drops it. Without
    // a source there is no Table filter, so a table from the address stays.
    const table_id =
      source_id !== filters.source_id
        ? undefined
        : filters.source_id
          ? params["filter[table_id]"] || undefined
          : filters.table_id;
    if (source_id !== filters.source_id || table_id !== filters.table_id) {
      setFilters({ ...filters, source_id, table_id });
    }
  };

  return (
    <>
      <PageHeader title="Grants" divider={false} />
      <div className="z-list-toolbar">
        <div className="z-list-toolbar-filters z-grants-toolbar">
          {sourceChip && (
            <FilterChip
              clearLabel="Clear source"
              onClear={() =>
                setFilters({
                  ...filters,
                  source_id: undefined,
                  table_id: undefined,
                })
              }
            >
              Source: {sourceChip}
            </FilterChip>
          )}
          {tableChip && (
            <FilterChip
              clearLabel="Clear table"
              onClear={() => setFilters({ ...filters, table_id: undefined })}
            >
              Table: {tableChip}
            </FilterChip>
          )}
          {principal ? (
            <FilterChip
              clearLabel="Clear person or group"
              onClear={clearPrincipal}
            >
              <PrincipalLabel refValue={principal} />
            </FilterChip>
          ) : (
            <Button
              size="sm"
              variant="secondary"
              fullWidth={false}
              onClick={() => setPickingPrincipal(true)}
            >
              <FontAwesomeIcon icon={faUser} /> Person or group
            </Button>
          )}
          {filtersReady && (
            <div className="z-grants-tablefilters">
              <TableFilters filters={filterDefs} onChange={onFiltersChange} />
            </div>
          )}
        </div>
        {canWrite && (
          <Button
            size="sm"
            fullWidth={false}
            onClick={() => navigate("/grants/new")}
          >
            New grant
          </Button>
        )}
      </div>
      {selectsUnavailable && (
        <Alert variant="warning">
          Filtering by source or table needs the Read sources permission.
        </Alert>
      )}
      <ErrorNotice
        error={sources.error?.status === 403 ? null : sources.error}
      />
      <Modal
        show={pickingPrincipal}
        title="Show grants for a person or group"
        onClose={() => setPickingPrincipal(false)}
      >
        <PrincipalPicker
          value={principal}
          onChange={(p) => {
            setFilters({
              ...filters,
              principal_type: p.type,
              principal_id: p.id,
            });
            setPickingPrincipal(false);
          }}
        />
      </Modal>
      <ErrorNotice error={error} />
      {isLoading ? (
        <Spinner size="lg" />
      ) : (
        <div className={canWrite ? "z-actions-last" : undefined}>
          <Table<Grant>
            rowKey={(grant) => grant.id}
            emptyMessage={
              error ? undefined : (
                <EmptyState>
                  {anyFilter
                    ? "No grant matches these filters."
                    : "No grants yet."}
                </EmptyState>
              )
            }
            columns={[
              {
                title: "Principal",
                cellElement: (grant) => (
                  <PrincipalCell
                    principal_type={grant.principal_type}
                    principal_id={grant.principal_id}
                    status={grant.principal_status}
                  />
                ),
              },
              {
                title: "Source",
                cellElement: (grant) => (
                  <Link
                    className="z-plain-link"
                    to={`/sources/${grant.source.id}`}
                  >
                    {sources.sources.find((x) => x.id === grant.source.id)
                      ?.name ?? grant.source.slug}
                  </Link>
                ),
              },
              {
                title: "Table",
                cellElement: (grant) => (
                  <>
                    <Link
                      className="z-plain-link"
                      to={`/sources/${grant.source.id}/tables/${grant.table.id}`}
                    >
                      <span className="z-muted">
                        {grant.table.schema_name}.
                      </span>
                      {grant.table.name}
                    </Link>
                    {grant.table.missing && (
                      <>
                        {" "}
                        <Badge variant="warning" size="sm">
                          Missing
                        </Badge>
                      </>
                    )}
                  </>
                ),
              },
              { title: "Columns", cellElement: columnsText },
              ...(canWrite
                ? [
                    {
                      title: "",
                      cellElement: (grant: Grant) => (
                        <RowActions align="end">
                          <EditButton
                            onClick={() => navigate(`/grants/${grant.id}/edit`)}
                          />
                          <GrantDeleteButton
                            grant={grant}
                            size="sm"
                            icon={faTrash}
                            label="Delete"
                            confirmLabel="Delete grant"
                          />
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
        <div className="z-grants-more">
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
    </>
  );
};
