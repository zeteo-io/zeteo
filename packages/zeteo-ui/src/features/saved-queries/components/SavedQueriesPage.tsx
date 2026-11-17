import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { useDeleteSavedQuery } from "../api/useDeleteSavedQuery";
import { useAllSavedQueries } from "../api/useAllSavedQueries";
import { ConfirmButton } from "@/components/ConfirmButton";
import { formatRelative } from "@/utils/formatRelative";
import { ErrorNotice } from "@/components/ErrorNotice";
import { PageHeader } from "@/components/PageHeader";
import { FilterChip } from "@/components/FilterChip";
import { useUrlFilters } from "@/lib/useUrlFilters";
import { useAllSources } from "@/features/sources";
import { TransferDialog } from "./TransferDialog";
import { formatDate } from "@/utils/formatDate";
import type { SavedQuery } from "../api/types";
import { useEffect, useState } from "react";
import { ShareDialog } from "./ShareDialog";
import { useAuth } from "@tereo-io/react";
import "./styles.css";
import {
  faRightLeft,
  faShareNodes,
  faTrash,
  faUser,
} from "@fortawesome/free-solid-svg-icons";
import {
  PrincipalLabel,
  PrincipalPicker,
  type PrincipalRef,
} from "@/features/principals";
import {
  Button,
  EmptyState,
  Modal,
  RowActions,
  Spinner,
  Table,
  TableFilters,
  type InfiniteScrollMenuFilter,
} from "@kosmeo-ui/react";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface Filters {
  owner_id?: string;
  source_id?: string;
}

const idOf = (value: string | null) =>
  value && UUID.test(value) ? value.toLowerCase() : undefined;

const filtersOf = (params: URLSearchParams): Filters => ({
  owner_id: idOf(params.get("owner_id")),
  source_id: idOf(params.get("source_id")),
});

type Dialog = { kind: "share" | "transfer"; id: string } | null;

export const SavedQueriesPage = () => {
  const { hasPermission } = useAuth();
  const canWrite = hasPermission("zeteo.saved_queries.write");
  const canReadSources = hasPermission("zeteo.sources.read");
  // GET /v1/principals needs zeteo.grants.read; a lookup by id needs only this.
  const canSearchPeople = hasPermission("zeteo.grants.read");
  const [urlFilters, setFilters] = useUrlFilters(
    ["owner_id", "source_id"],
    filtersOf
  );
  // Without zeteo.sources.read a source filter would only be refused.
  const filters: Filters = {
    owner_id: urlFilters.owner_id,
    source_id: canReadSources ? urlFilters.source_id : undefined,
  };
  const [search, setSearch] = useState("");
  const { items, isLoading, error, hasMore, loadMore } = useAllSavedQueries({
    ...filters,
    q: search || undefined,
  });
  const sources = useAllSources(canReadSources);
  const remove = useDeleteSavedQuery();
  const [pickingPerson, setPickingPerson] = useState(false);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  useEffect(() => setLoadingMore(false), [items.length, hasMore, error]);

  const sourceSelect = canReadSources && sources.error?.status !== 403;
  const ownerRef: PrincipalRef | null = filters.owner_id
    ? { type: "user", id: filters.owner_id }
    : null;
  const anyFilter = !!(filters.owner_id || filters.source_id || search);

  const filterDefs: InfiniteScrollMenuFilter[] = [
    { type: "SEARCH", title: "Search", dataKey: "q" },
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
  const filtersReady = !(sourceSelect && sources.isLoading);

  const onFiltersChange = (params: Record<string, string>) => {
    setSearch(params["filter[q]"] ?? "");
    if (!sourceSelect) return;
    const source_id = params["filter[source_id]"] || undefined;
    if (source_id !== filters.source_id) {
      setFilters({ ...urlFilters, source_id });
    }
  };

  const ownerName = (sq: SavedQuery) => sq.owner.name ?? sq.owner.id;

  return (
    <>
      <PageHeader title="Saved queries" divider={false} />
      <div className="z-list-toolbar">
        <div className="z-list-toolbar-filters">
          {ownerRef ? (
            <FilterChip
              clearLabel="Clear owner"
              onClear={() => setFilters({ ...urlFilters, owner_id: undefined })}
            >
              <PrincipalLabel refValue={ownerRef} />
            </FilterChip>
          ) : (
            <Button
              size="sm"
              variant="secondary"
              fullWidth={false}
              onClick={() => setPickingPerson(true)}
            >
              <FontAwesomeIcon icon={faUser} /> Owner
            </Button>
          )}
          {filtersReady && (
            <TableFilters filters={filterDefs} onChange={onFiltersChange} />
          )}
        </div>
      </div>
      <Modal
        show={pickingPerson}
        title="Show the saved queries of an owner"
        onClose={() => setPickingPerson(false)}
      >
        {!canSearchPeople && (
          <p>
            Searching by name needs the Read grants permission; paste a user id
            instead.
          </p>
        )}
        <PrincipalPicker
          types={["user"]}
          search={canSearchPeople}
          value={ownerRef}
          onChange={(p) => {
            setFilters({ ...urlFilters, owner_id: p.id });
            setPickingPerson(false);
          }}
        />
      </Modal>
      <ErrorNotice error={error} />
      <ErrorNotice
        error={sources.error?.status === 403 ? null : sources.error}
      />
      {isLoading ? (
        <Spinner size="lg" />
      ) : (
        <div className="z-actions-last">
          <Table<SavedQuery>
            rowKey={(sq) => sq.id}
            emptyMessage={
              error ? undefined : (
                <EmptyState>
                  {anyFilter
                    ? "No saved query matches these filters."
                    : "No saved queries yet."}
                </EmptyState>
              )
            }
            columns={[
              {
                title: "Name",
                cellElement: (sq) => (
                  <div>
                    {sq.name}
                    {sq.description && (
                      <div className="z-muted">{sq.description}</div>
                    )}
                  </div>
                ),
              },
              { title: "Owner", cellElement: ownerName },
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
                  sq.share_count === undefined ? (
                    <span className="z-muted">—</span>
                  ) : (
                    sq.share_count
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
        <ShareDialog savedQueryId={dialog.id} onClose={() => setDialog(null)} />
      )}
      {dialog?.kind === "transfer" && (
        <TransferDialog
          savedQueryId={dialog.id}
          onClose={() => setDialog(null)}
        />
      )}
    </>
  );
};
