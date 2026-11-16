import { tableLabel, useAllTables } from "@/features/tables";
import { GrantDeleteButton } from "./GrantDeleteButton";
import type { Grant, GrantFilters } from "../api/types";
import { ErrorNotice } from "@/components/ErrorNotice";
import { Link, useNavigate } from "react-router-dom";
import { PageHeader } from "@/components/PageHeader";
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
  Select,
  Spinner,
  Table,
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
  const sourceName = filters.source_id
    ? (sources.sources.find((x) => x.id === filters.source_id)?.slug ??
      items.find((g) => g.source.id === filters.source_id)?.source.slug ??
      filters.source_id)
    : "";
  const tableName = filters.table_id
    ? (() => {
        const known =
          tables.tables.find((t) => t.id === filters.table_id) ??
          items.find((g) => g.table.id === filters.table_id)?.table;
        return known ? tableLabel(known) : filters.table_id;
      })()
    : "";
  const selectsUnavailable = !canReadSources || sources.error?.status === 403;
  const canWrite = hasPermission("zeteo.grants.write");

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
        {anyFilter && (
          <ul className="z-grants-chips" aria-label="Active filters">
            {filters.source_id && (
              <li>
                Source: <code>{sourceName}</code>{" "}
                <Button
                  size="sm"
                  variant="secondary"
                  fullWidth={false}
                  aria-label="Clear source"
                  onClick={() =>
                    setFilters({
                      ...filters,
                      source_id: undefined,
                      table_id: undefined,
                    })
                  }
                >
                  Clear
                </Button>
              </li>
            )}
            {filters.table_id && (
              <li>
                Table: <code>{tableName}</code>{" "}
                <Button
                  size="sm"
                  variant="secondary"
                  fullWidth={false}
                  aria-label="Clear table"
                  onClick={() =>
                    setFilters({ ...filters, table_id: undefined })
                  }
                >
                  Clear
                </Button>
              </li>
            )}
            {principal && (
              <li>
                Principal: <PrincipalLabel refValue={principal} />{" "}
                <Button
                  size="sm"
                  variant="secondary"
                  fullWidth={false}
                  aria-label="Clear principal"
                  onClick={() =>
                    setFilters({
                      ...filters,
                      principal_type: undefined,
                      principal_id: undefined,
                    })
                  }
                >
                  Clear
                </Button>
              </li>
            )}
            <li>
              <Button
                size="sm"
                variant="secondary"
                fullWidth={false}
                onClick={() => setFilters({})}
              >
                Clear all
              </Button>
            </li>
          </ul>
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
                        <GrantDeleteButton
                          grant={grant}
                          label="Delete"
                          confirmLabel="Delete grant"
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
