import { sourceHref, sourceTypeName } from "./sourceLabels";
import { fromPage, type SourceBack } from "./sourceBack";
import { formatRelative } from "@/utils/formatRelative";
import { ErrorNotice } from "@/components/ErrorNotice";
import { PrincipalLabel } from "@/features/principals";
import { formatBytes } from "@/utils/formatBytes";
import { useState, type ReactNode } from "react";
import { formatDate } from "@/utils/formatDate";
import { SourceStatus } from "./SourceStatus";
import type { Source } from "../api/types";
import type { ApiError } from "@/lib/api";
import { Link } from "react-router-dom";
import "./styles.css";
import {
  EmptyState,
  RowActions,
  Spinner,
  Switch,
  Table,
  TableCellLink,
  TableFilters,
  type InfiniteScrollMenuFilter,
} from "@kosmeo-ui/react";

const SEARCH: InfiniteScrollMenuFilter = {
  type: "SEARCH",
  title: "Search",
  dataKey: "q",
};
const KIND: InfiniteScrollMenuFilter = {
  type: "SELECT",
  title: "Kind",
  dataKey: "type",
  options: [
    { id: "postgres", name: "PostgreSQL", selected: false },
    { id: "azure-sql", name: "Azure SQL", selected: false },
    { id: "upload", name: "Upload", selected: false },
  ],
};
const ALL_FILTERS = [SEARCH, KIND];
const SEARCH_ONLY = [SEARCH];

/** Columns a list can leave out. */
export type SourceListColumn = "kind" | "owner" | "status" | "refreshed";

const Time = ({ iso }: { iso: string }) => (
  <time dateTime={iso} title={formatDate(iso)}>
    {formatRelative(iso)}
  </time>
);

interface SourcesListProps {
  sources: Source[];
  isLoading: boolean;
  error: ApiError | null;
  /** Where a source's page links back to: the page this list is on. */
  back: SourceBack;
  /** Columns left out (all are shown by default). */
  hide?: SourceListColumn[];
  /** The list's own buttons, right of the filters. */
  actions?: ReactNode;
  /** A Kind filter and a "Show archived" switch: for a list of every kind. */
  allKinds?: boolean;
  /** A row's actions, in a last column as wide as its buttons. */
  rowActions?: (source: Source) => ReactNode;
  /** Said when there is nothing to list at all. */
  emptyText: ReactNode;
}

/** A list of sources: the admin Sources page and My Zeteo's My sources. */
export const SourcesList = ({
  sources,
  isLoading,
  error,
  back,
  hide = [],
  actions,
  allKinds = false,
  rowActions,
  emptyText,
}: SourcesListProps) => {
  const [includeArchived, setIncludeArchived] = useState(false);
  const [params, setParams] = useState<Record<string, string>>({});
  const shows = (column: SourceListColumn) => !hide.includes(column);

  const q = params["filter[q]"]?.toLowerCase();
  const type = params["filter[type]"];
  const shown = sources.filter(
    (s) =>
      (includeArchived || !s.archived_at) &&
      (!q ||
        s.name.toLowerCase().includes(q) ||
        s.slug.toLowerCase().includes(q)) &&
      (!type || s.type === type)
  );
  const anyVisible = sources.some((s) => includeArchived || !s.archived_at);

  return (
    <>
      <div className="z-list-toolbar">
        <div className="z-list-toolbar-filters">
          <TableFilters
            filters={allKinds ? ALL_FILTERS : SEARCH_ONLY}
            onChange={setParams}
          />
        </div>
        {actions}
        {allKinds && (
          <Switch
            size="sm"
            label="Show archived"
            checked={includeArchived}
            onChange={(e) => setIncludeArchived(e.target.checked)}
          />
        )}
      </div>
      <ErrorNotice error={error} />
      {isLoading ? (
        <Spinner size="lg" />
      ) : (
        <div className={rowActions ? "z-actions-last" : undefined}>
          <Table<Source>
            rowKey={(source) => source.id}
            emptyMessage={
              error ? undefined : anyVisible ? (
                <EmptyState>No sources match these filters.</EmptyState>
              ) : (
                <EmptyState>{emptyText}</EmptyState>
              )
            }
            columns={[
              {
                title: "Name",
                cellElement: (source) => (
                  <span className="z-sources-name">
                    <TableCellLink
                      as={Link}
                      to={sourceHref(source.id)}
                      state={fromPage(back)}
                    >
                      {source.name}
                    </TableCellLink>
                    <code className="z-muted">{source.slug}</code>
                  </span>
                ),
              },
              ...(shows("kind")
                ? [
                    {
                      title: "Kind",
                      cellElement: (source: Source) =>
                        sourceTypeName(source.type),
                    },
                  ]
                : []),
              ...(shows("owner")
                ? [
                    {
                      title: "Owner",
                      cellElement: (source: Source) =>
                        source.owner_id ? (
                          <PrincipalLabel
                            refValue={{ type: "user", id: source.owner_id }}
                          />
                        ) : (
                          <span className="z-muted">—</span>
                        ),
                    },
                  ]
                : []),
              ...(shows("status")
                ? [
                    {
                      title: "Status",
                      width: "1%",
                      cellElement: (source: Source) => (
                        <SourceStatus source={source} />
                      ),
                    },
                  ]
                : []),
              {
                title: "Size",
                cellElement: (source) =>
                  source.size_bytes === null ? (
                    <span className="z-muted">—</span>
                  ) : (
                    formatBytes(source.size_bytes)
                  ),
              },
              {
                title: "Shared with",
                cellElement: (source) =>
                  source.share_count > 0 ? (
                    source.share_count.toLocaleString()
                  ) : (
                    <span className="z-muted">Not shared</span>
                  ),
              },
              ...(shows("refreshed")
                ? [
                    {
                      title: "Last refreshed",
                      cellElement: (source: Source) =>
                        source.last_refreshed_at ? (
                          <Time iso={source.last_refreshed_at} />
                        ) : (
                          // An upload is never refreshed: it is loaded.
                          <span className="z-muted">
                            {source.type === "upload" ? "—" : "Never"}
                          </span>
                        ),
                    },
                  ]
                : []),
              {
                title: "Added",
                cellElement: (source) => <Time iso={source.created_at} />,
              },
              ...(rowActions
                ? [
                    {
                      title: "",
                      cellElement: (source: Source) => (
                        <RowActions align="end">
                          {rowActions(source)}
                        </RowActions>
                      ),
                    },
                  ]
                : []),
            ]}
            rows={shown}
          />
        </div>
      )}
    </>
  );
};
