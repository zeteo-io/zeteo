import { PrincipalLabel, PrincipalPicker } from "@/features/principals";
import { ShareDialog, TransferDialog } from "@/features/saved-queries";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { ConfirmButton } from "@/components/ConfirmButton";
import { formatRelative } from "@/utils/formatRelative";
import "@/features/saved-queries/components/styles.css";
import { ErrorNotice } from "@/components/ErrorNotice";
import { PageHeader } from "@/components/PageHeader";
import { FilterChip } from "@/components/FilterChip";
import { useUrlFilters } from "@/lib/useUrlFilters";
import { formatDate } from "@/utils/formatDate";
import type { ApiError } from "@/lib/api";
import { useAuth } from "@tereo-io/react";
import { Link } from "react-router-dom";
import { useState } from "react";
import {
  faRightLeft,
  faShareNodes,
  faTrash,
  faUser,
} from "@fortawesome/free-solid-svg-icons";
import {
  Button,
  EmptyState,
  Modal,
  RowActions,
  Spinner,
  Table,
  TableCellLink,
  TableFilters,
} from "@kosmeo-ui/react";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface Filters {
  owner_id?: string;
}

const filtersOf = (params: URLSearchParams): Filters => {
  const id = params.get("owner_id");
  return { owner_id: id && UUID.test(id) ? id.toLowerCase() : undefined };
};

/** What the list needs of a dashboard or a saved panel. */
export interface AdminRow {
  id: string;
  name: string;
  description: string;
  owner: { id: string; name: string | null };
  share_count?: number;
  updated_at: string;
}

interface AdminListProps<T extends AdminRow> {
  title: string;
  objectType: "dashboard" | "saved_panel";
  /** What one is called in sentences: "dashboard", "saved panel". */
  noun: string;
  /** The row's link to its page; none for a saved panel (it has no page). */
  href?: (row: T) => string;
  /** Extra text after the name: where a saved panel is used. */
  extraColumn?: { title: string; cell: (row: T) => string };
  deleteText: (row: T) => string;
  useList: (filters: { owner_id?: string; q?: string }) => {
    items: T[];
    isLoading: boolean;
    error: ApiError | null;
    hasMore: boolean;
    loadMore: () => void;
  };
  useRemove: () => { mutateAsync: (id: string) => Promise<unknown> };
}

type Dialog = { kind: "share" | "transfer"; id: string } | null;

/** Every dashboard, or every saved panel, for admins: filter by owner or name; share, transfer, delete with write. */
export const AdminList = <T extends AdminRow>({
  title,
  objectType,
  noun,
  href,
  extraColumn,
  deleteText,
  useList,
  useRemove,
}: AdminListProps<T>) => {
  const { hasPermission } = useAuth();
  const canWrite = hasPermission("zeteo.dashboards.write");
  // GET /v1/principals needs zeteo.grants.read; a lookup by id needs only this.
  const canSearchPeople = hasPermission("zeteo.grants.read");
  const [filters, setFilters] = useUrlFilters(["owner_id"], filtersOf);
  const [search, setSearch] = useState("");
  const { items, isLoading, error, hasMore, loadMore } = useList({
    ...filters,
    q: search || undefined,
  });
  const remove = useRemove();
  const [picking, setPicking] = useState(false);
  const [dialog, setDialog] = useState<Dialog>(null);
  const ownerRef = filters.owner_id
    ? ({ type: "user", id: filters.owner_id } as const)
    : null;
  const ownerName = (row: T) => row.owner.name ?? row.owner.id;

  return (
    <>
      <PageHeader title={title} divider={false} />
      <div className="z-list-toolbar">
        <div className="z-list-toolbar-filters z-sq-toolbar">
          {ownerRef ? (
            <FilterChip
              clearLabel="Clear owner"
              onClear={() => setFilters({ owner_id: undefined })}
            >
              <PrincipalLabel refValue={ownerRef} />
            </FilterChip>
          ) : (
            <Button
              size="sm"
              variant="secondary"
              fullWidth={false}
              onClick={() => setPicking(true)}
            >
              <FontAwesomeIcon icon={faUser} /> Owner
            </Button>
          )}
          <div className="z-sq-tablefilters">
            <TableFilters
              filters={[{ type: "SEARCH", title: "Search", dataKey: "q" }]}
              onChange={(params) => setSearch(params["filter[q]"] ?? "")}
            />
          </div>
        </div>
      </div>
      <Modal
        show={picking}
        title={`Show the ${noun}s of an owner`}
        onClose={() => setPicking(false)}
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
            setFilters({ owner_id: p.id });
            setPicking(false);
          }}
        />
      </Modal>
      <ErrorNotice error={error} />
      {isLoading ? (
        <Spinner size="lg" />
      ) : (
        <div className="z-actions-last z-sq-list">
          <Table<T>
            rowKey={(row) => row.id}
            emptyMessage={
              error ? undefined : (
                <EmptyState>
                  {filters.owner_id || search
                    ? `No ${noun}s match these filters.`
                    : `No ${noun}s yet.`}
                </EmptyState>
              )
            }
            columns={[
              {
                title: "Name",
                cellElement: (row) => (
                  <span className="z-sq-name">
                    {href ? (
                      <TableCellLink as={Link} to={href(row)}>
                        {row.name}
                      </TableCellLink>
                    ) : (
                      row.name
                    )}
                    {row.description && (
                      <span className="z-muted" title={row.description}>
                        {row.description}
                      </span>
                    )}
                  </span>
                ),
              },
              {
                title: "Owner",
                cellElement: (row) => (
                  <span className="z-principal-cell">
                    <FontAwesomeIcon
                      className="z-principal-icon"
                      icon={faUser}
                      aria-hidden
                    />
                    {ownerName(row)}
                  </span>
                ),
              },
              ...(extraColumn
                ? [
                    {
                      title: extraColumn.title,
                      cellElement: (row: T) => extraColumn.cell(row),
                    },
                  ]
                : []),
              {
                title: "Shared with",
                cellElement: (row) =>
                  row.share_count ? (
                    `${row.share_count} ${row.share_count === 1 ? "person or group" : "people or groups"}`
                  ) : (
                    <span className="z-muted">Not shared</span>
                  ),
              },
              {
                title: "Updated",
                cellElement: (row) => (
                  <time title={formatDate(row.updated_at)}>
                    {formatRelative(row.updated_at)}
                  </time>
                ),
              },
              ...(canWrite
                ? [
                    {
                      title: "",
                      cellElement: (row: T) => (
                        <RowActions align="end">
                          <Button
                            size="sm"
                            variant="secondary"
                            fullWidth={false}
                            aria-label="Share"
                            title="Share"
                            onClick={() =>
                              setDialog({ kind: "share", id: row.id })
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
                              setDialog({ kind: "transfer", id: row.id })
                            }
                          >
                            <FontAwesomeIcon icon={faRightLeft} />
                          </Button>
                          <ConfirmButton
                            danger
                            size="sm"
                            icon={faTrash}
                            label="Delete"
                            confirmTitle={`Delete this ${noun}?`}
                            confirmText={deleteText(row)}
                            confirmLabel="Delete"
                            onConfirm={() => remove.mutateAsync(row.id)}
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
          <Button variant="secondary" fullWidth={false} onClick={loadMore}>
            Load more
          </Button>
        </div>
      )}
      {dialog?.kind === "share" && (
        <ShareDialog
          objectType={objectType}
          id={dialog.id}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === "transfer" && (
        <TransferDialog
          objectType={objectType}
          id={dialog.id}
          onClose={() => setDialog(null)}
        />
      )}
    </>
  );
};
