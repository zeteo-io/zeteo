import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { useDeleteSavedQuery } from "../api/useDeleteSavedQuery";
import { useAllSavedQueries } from "../api/useAllSavedQueries";
import { ConfirmButton } from "@/components/ConfirmButton";
import { formatRelative } from "@/utils/formatRelative";
import { ErrorNotice } from "@/components/ErrorNotice";
import { PageHeader } from "@/components/PageHeader";
import { FilterChip } from "@/components/FilterChip";
import { useEffect, useMemo, useState } from "react";
import { useUrlFilters } from "@/lib/useUrlFilters";
import { useAllSources } from "@/features/sources";
import { TransferDialog } from "./TransferDialog";
import { formatDate } from "@/utils/formatDate";
import type { SavedQuery } from "../api/types";
import { ShareDialog } from "./ShareDialog";
import { useAuth } from "@tereo-io/react";
import { Link } from "react-router-dom";
import "./styles.css";
import {
  faRightLeft,
  faShareNodes,
  faTrash,
  faUser,
} from "@fortawesome/free-solid-svg-icons";
import {
  PrincipalLabel,
  parseWho,
  useDirectory,
  whoFilter,
  whoId,
  type PrincipalRef,
} from "@/features/principals";
import {
  Alert,
  Button,
  EmptyState,
  RowActions,
  Spinner,
  Table,
  TableCellLink,
  TableFilters,
  type InfiniteScrollMenuFilter,
} from "@kosmeo-ui/react";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface Filters {
  owner_id?: string;
  source_id?: string;
  shared_with_type?: "user" | "group";
  shared_with_id?: string;
}

const idOf = (value: string | null) =>
  value && UUID.test(value) ? value.toLowerCase() : undefined;

const filtersOf = (params: URLSearchParams): Filters => {
  const type = params.get("shared_with_type");
  const id = idOf(params.get("shared_with_id"));
  // Both or neither.
  const shared = (type === "user" || type === "group") && id;
  return {
    owner_id: idOf(params.get("owner_id")),
    source_id: idOf(params.get("source_id")),
    shared_with_type: shared ? type : undefined,
    shared_with_id: shared ? id : undefined,
  };
};

type Dialog = { kind: "share" | "transfer"; id: string } | null;

export const SavedQueriesPage = () => {
  const { hasPermission } = useAuth();
  const canWrite = hasPermission("zeteo.saved_queries.write");
  const canReadSources = hasPermission("zeteo.sources.read");
  // The directory needs zeteo.grants.read; a lookup by id needs only this.
  const canListPeople = hasPermission("zeteo.grants.read");
  const [urlFilters, setFilters] = useUrlFilters(
    ["owner_id", "source_id", "shared_with_type", "shared_with_id"],
    filtersOf
  );
  // Without zeteo.sources.read a source filter would only be refused.
  const filters: Filters = {
    owner_id: urlFilters.owner_id,
    shared_with_type: urlFilters.shared_with_type,
    shared_with_id: urlFilters.shared_with_id,
    source_id: canReadSources ? urlFilters.source_id : undefined,
  };
  const [search, setSearch] = useState("");
  const { items, isLoading, error, hasMore, loadMore } = useAllSavedQueries({
    ...filters,
    q: search || undefined,
  });
  const sources = useAllSources(canReadSources);
  const remove = useDeleteSavedQuery();
  const directory = useDirectory("admin", canListPeople);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  useEffect(() => setLoadingMore(false), [items.length, hasMore, error]);

  const sourceSelect = canReadSources && sources.error?.status !== 403;
  const ownerRef: PrincipalRef | null = filters.owner_id
    ? { type: "user", id: filters.owner_id }
    : null;
  const sharedRef: PrincipalRef | null =
    filters.shared_with_type && filters.shared_with_id
      ? { type: filters.shared_with_type, id: filters.shared_with_id }
      : null;
  const anyFilter = !!(
    filters.owner_id ||
    filters.source_id ||
    sharedRef ||
    search
  );

  // Owner and Shared with choose from the whole directory; without it, a
  // choice from the address is a chip.
  const peopleSelect = !!directory.data;
  const selectedOwner = filters.owner_id ? whoId("user", filters.owner_id) : "";
  const selectedShared = sharedRef ? whoId(sharedRef.type, sharedRef.id) : "";
  const people = useMemo(
    () =>
      directory.data
        ? [
            whoFilter(directory.data.data, {
              title: "Owner",
              dataKey: "owner",
              selected: selectedOwner,
              only: ["user"],
            }),
            whoFilter(directory.data.data, {
              title: "Shared with",
              dataKey: "shared_with",
              selected: selectedShared,
            }),
          ]
        : [],
    [directory.data, selectedOwner, selectedShared]
  );

  const filterDefs: InfiniteScrollMenuFilter[] = [
    { type: "SEARCH", title: "Search", dataKey: "q" },
    ...people,
    ...(sourceSelect
      ? [
          {
            type: "SELECT" as const,
            title: "Source",
            dataKey: "source_id",
            options: sources.sources.map((s) => ({
              id: s.id,
              name: `${s.name}${s.archived_at ? " (archived)" : ""}`,
              selected: s.id === filters.source_id,
            })),
          },
        ]
      : []),
  ];
  // It reports its choices as soon as it mounts, so it waits for the options
  // that hold the current choices; otherwise it would report them gone.
  const filtersReady =
    !(sourceSelect && sources.isLoading) && !directory.isLoading;

  const onFiltersChange = (params: Record<string, string>) => {
    setSearch(params["filter[q]"] ?? "");
    const next = { ...urlFilters };
    if (sourceSelect) {
      next.source_id = params["filter[source_id]"] || undefined;
    }
    if (peopleSelect) {
      next.owner_id = parseWho(params, "owner").principal_id;
      const shared = parseWho(params, "shared_with");
      next.shared_with_type = shared.principal_type;
      next.shared_with_id = shared.principal_id;
    }
    if (
      (Object.keys(next) as (keyof Filters)[]).some(
        (key) => next[key] !== urlFilters[key]
      )
    ) {
      setFilters(next);
    }
  };

  const ownerName = (sq: SavedQuery) => sq.owner.name ?? sq.owner.id;

  return (
    <>
      <PageHeader title="Saved queries" divider={false} />
      <div className="z-list-toolbar">
        <div className="z-list-toolbar-filters z-sq-toolbar">
          {ownerRef && !peopleSelect && (
            <FilterChip
              clearLabel="Clear owner"
              onClear={() => setFilters({ ...urlFilters, owner_id: undefined })}
            >
              <PrincipalLabel refValue={ownerRef} />
            </FilterChip>
          )}
          {sharedRef && !peopleSelect && (
            <FilterChip
              clearLabel="Clear shared with"
              onClear={() =>
                setFilters({
                  ...urlFilters,
                  shared_with_type: undefined,
                  shared_with_id: undefined,
                })
              }
            >
              Shared with <PrincipalLabel refValue={sharedRef} />
            </FilterChip>
          )}
          {filtersReady && (
            <div className="z-sq-tablefilters">
              <TableFilters filters={filterDefs} onChange={onFiltersChange} />
            </div>
          )}
        </div>
      </div>
      {!canListPeople && (
        <Alert variant="warning">
          Filtering by owner or by who it is shared with needs the Read grants
          permission.
        </Alert>
      )}
      <ErrorNotice error={error} />
      <ErrorNotice
        error={sources.error?.status === 403 ? null : sources.error}
      />
      <ErrorNotice error={directory.error} />
      {isLoading ? (
        <Spinner size="lg" />
      ) : (
        <div className="z-actions-last z-sq-list">
          <Table<SavedQuery>
            rowKey={(sq) => sq.id}
            emptyMessage={
              error ? undefined : (
                <EmptyState>
                  {anyFilter
                    ? "No saved queries match these filters."
                    : "No saved queries yet. People save queries from My Zeteo, the API or an AI over MCP."}
                </EmptyState>
              )
            }
            columns={[
              {
                title: "Name",
                cellElement: (sq) => (
                  <TableCellLink as={Link} to={`/my/saved-queries/${sq.id}`}>
                    {sq.name}
                  </TableCellLink>
                ),
              },
              {
                title: "Description",
                cellElement: (sq) =>
                  sq.description ? (
                    <span className="z-sq-desc" title={sq.description}>
                      {sq.description}
                    </span>
                  ) : null,
              },
              {
                title: "Owner",
                cellElement: (sq) => (
                  <span className="z-principal-cell">
                    <FontAwesomeIcon
                      className="z-principal-icon"
                      icon={faUser}
                      aria-hidden
                    />
                    {ownerName(sq)}
                  </span>
                ),
              },
              ...(canReadSources
                ? [
                    {
                      title: "Source",
                      cellElement: (sq: SavedQuery) =>
                        sq.source ? (
                          sq.source.slug
                        ) : (
                          <span className="z-muted">—</span>
                        ),
                    },
                  ]
                : []),
              {
                title: "Shared with",
                cellElement: (sq) =>
                  sq.share_count ? (
                    `${sq.share_count} ${sq.share_count === 1 ? "person or group" : "people or groups"}`
                  ) : (
                    <span className="z-muted">Not shared</span>
                  ),
              },
              {
                title: "Last run",
                cellElement: (sq) =>
                  sq.last_run_at ? (
                    <time title={formatDate(sq.last_run_at)}>
                      {formatRelative(sq.last_run_at)}
                    </time>
                  ) : (
                    <span className="z-muted">Never</span>
                  ),
              },
              ...(canWrite
                ? [
                    {
                      title: "",
                      cellElement: (sq: SavedQuery) => (
                        <RowActions align="end">
                          <Button
                            size="sm"
                            variant="secondary"
                            fullWidth={false}
                            aria-label="Share"
                            title="Share"
                            onClick={() =>
                              setDialog({ kind: "share", id: sq.id })
                            }
                          >
                            <FontAwesomeIcon icon={faShareNodes} />
                          </Button>
                          <Button
                            size="sm"
                            variant="secondary"
                            fullWidth={false}
                            aria-label="Transfer"
                            title="Transfer"
                            onClick={() =>
                              setDialog({ kind: "transfer", id: sq.id })
                            }
                          >
                            <FontAwesomeIcon icon={faRightLeft} />
                          </Button>
                          <ConfirmButton
                            danger
                            size="sm"
                            icon={faTrash}
                            label="Delete"
                            confirmTitle="Delete this saved query?"
                            confirmText={`Delete "${sq.name}", owned by ${ownerName(sq)}? It stops being shared and cannot be recovered.`}
                            confirmLabel="Delete"
                            onConfirm={() => remove.mutateAsync(sq.id)}
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
        <div className="z-sq-more">
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
      {dialog?.kind === "share" && (
        <ShareDialog
          objectType="saved_query"
          id={dialog.id}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === "transfer" && (
        <TransferDialog
          objectType="saved_query"
          id={dialog.id}
          onClose={() => setDialog(null)}
        />
      )}
    </>
  );
};
