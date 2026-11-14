import { PrincipalPicker, type PrincipalRef } from "@/features/principals";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { tableLabel, useAllTables } from "@/features/tables";
import { ConfirmButton } from "@/components/ConfirmButton";
import type { Grant, GrantFilters } from "../api/types";
import { ErrorNotice } from "@/components/ErrorNotice";
import { useDeleteGrant } from "../api/useDeleteGrant";
import { PageHeader } from "@/components/PageHeader";
import { useAllSources } from "../api/useAllSources";
import { PrincipalCell } from "./PrincipalCell";
import { useGrants } from "../api/useGrants";
import { useEffect, useState } from "react";
import { useAuth } from "@/lib/auth";
import "./styles.css";
import {
  Alert,
  Badge,
  Button,
  EmptyState,
  Select,
  Spinner,
  Table,
} from "@kosmeo-ui/react";

const columnsText = (grant: Grant) =>
  grant.all_columns
    ? "All columns"
    : `${grant.columns.length} ${grant.columns.length === 1 ? "column" : "columns"}`;

const filtersOf = (params: URLSearchParams): GrantFilters => {
  const type = params.get("principal_type");
  return {
    source_id: params.get("source_id") || undefined,
    table_id: params.get("table_id") || undefined,
    principal_type: type === "user" || type === "group" ? type : undefined,
    principal_id: params.get("principal_id") || undefined,
  };
};

export const GrantsPage = () => {
  const { can } = useAuth();
  const navigate = useNavigate();
  const del = useDeleteGrant();
  const [params, setParams] = useSearchParams();
  const filters = filtersOf(params);
  const canReadSources = can("zeteo.sources.read");
  const { items, isLoading, error, hasMore, loadMore } = useGrants(filters);
  const sources = useAllSources(canReadSources);
  const tables = useAllTables(canReadSources ? filters.source_id : undefined);
  const [pickingPrincipal, setPickingPrincipal] = useState(false);

  const [loadingMore, setLoadingMore] = useState(false);
  useEffect(() => setLoadingMore(false), [items.length, hasMore, error]);

  const setFilters = (next: GrantFilters) => {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(next)) {
      if (value) query.set(key, value);
    }
    setParams(query, { replace: true });
  };
  const principal: PrincipalRef | null =
    filters.principal_type && filters.principal_id
      ? { type: filters.principal_type, id: filters.principal_id }
      : null;
  const selectsUnavailable = !canReadSources || sources.error?.status === 403;
  const canWrite = can("zeteo.grants.write");

  return (
    <>
      <PageHeader
        title="Grants"
        subtitle="Which tables and columns each user and group may query"
        actions={
          canWrite && (
            <Button fullWidth={false} onClick={() => navigate("/grants/new")}>
              New grant
            </Button>
          )
        }
      />
      {selectsUnavailable ? (
        <Alert variant="warning">
          Filtering by source or table needs the Read sources permission.
        </Alert>
      ) : (
        <div className="z-grants-filters">
          <Select
            label="Source"
            placeholder="All sources"
            value={filters.source_id ?? ""}
            disabled={sources.isLoading}
            options={sources.sources.map((s) => ({
              value: s.id,
              label: `${s.name} (${s.slug})${s.archived_at ? " (archived)" : ""}`,
            }))}
            onChange={(id) =>
              setFilters({ ...filters, source_id: id, table_id: undefined })
            }
          />
          <Select
            label="Table"
            placeholder="All tables"
            value={filters.table_id ?? ""}
            disabled={!filters.source_id || tables.isLoading}
            options={tables.tables.map((t) => ({
              value: t.id,
              label: `${tableLabel(t)}${t.missing_since ? " (missing)" : ""}`,
            }))}
            onChange={(id) => setFilters({ ...filters, table_id: id })}
          />
        </div>
      )}
      <ErrorNotice
        error={sources.error?.status === 403 ? null : sources.error}
      />
      <div className="z-grants-principal-filter">
        {principal && (
          <p>
            Principal:{" "}
            <code>
              {principal.type} {principal.id}
            </code>{" "}
            <Button
              size="sm"
              variant="secondary"
              fullWidth={false}
              onClick={() =>
                setFilters({
                  ...filters,
                  principal_type: undefined,
                  principal_id: undefined,
                })
              }
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
          <PrincipalPicker
            value={principal}
            onChange={(p) =>
              setFilters({
                ...filters,
                principal_type: p.type,
                principal_id: p.id,
              })
            }
          />
        )}
      </div>
      <ErrorNotice error={error} />
      {isLoading ? (
        <Spinner size="lg" />
      ) : (
        <Table<Grant>
          rowKey={(grant) => grant.id}
          emptyMessage={
            error ? undefined : <EmptyState>No grants yet.</EmptyState>
          }
          columns={[
            {
              title: "Principal",
              cellElement: (grant) => <PrincipalCell grant={grant} />,
            },
            {
              title: "Source",
              cellElement: (grant) => <code>{grant.source.slug}</code>,
            },
            {
              title: "Table",
              cellElement: (grant) => (
                <>
                  {tableLabel(grant.table)}
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
                      <div className="z-grants-actions">
                        <Link to={`/grants/${grant.id}/edit`}>Edit</Link>
                        <ConfirmButton
                          danger
                          label="Delete"
                          confirmTitle="Delete this grant?"
                          confirmText="The principal can no longer query this table through this grant."
                          confirmLabel="Delete grant"
                          onConfirm={() => del.mutateAsync(grant.id)}
                        />
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
