import { useDeleteFileSource, useFileSources } from "../api/fileSources";
import { faTrash } from "@fortawesome/free-solid-svg-icons";
import { ConfirmButton } from "@/components/ConfirmButton";
import { formatRelative } from "@/utils/formatRelative";
import { fileSourceHref, formatBytes } from "./labels";
import { ErrorNotice } from "@/components/ErrorNotice";
import { Link, useNavigate } from "react-router-dom";
import { formatDate } from "@/utils/formatDate";
import type { FileSource } from "../api/types";
import { useState } from "react";
import "./styles.css";
import {
  Button,
  EmptyState,
  RowActions,
  Spinner,
  Table,
  TableCellLink,
  TableFilters,
  type InfiniteScrollMenuFilter,
} from "@kosmeo-ui/react";

const FILTERS: InfiniteScrollMenuFilter[] = [
  { type: "SEARCH", title: "Search", dataKey: "q" },
];

/** The latest load of any of a source's tables. */
const lastLoaded = (source: FileSource): string | null =>
  source.tables
    .filter((t) => !t.missing && t.last_synced_at)
    .map((t) => t.last_synced_at!)
    .sort()
    .at(-1) ?? null;

const DeleteSource = ({ source }: { source: FileSource }) => {
  const remove = useDeleteFileSource();
  return (
    <ConfirmButton
      danger
      size="sm"
      icon={faTrash}
      label="Delete"
      confirmTitle="Delete source"
      confirmText={`Delete "${source.name}" and all its data? Zeteo holds the only copy, so it cannot be recovered. Saved queries and dashboards using it stop working.`}
      confirmLabel="Delete source"
      onConfirm={() => remove.mutateAsync(source.id)}
    />
  );
};

/** My Zeteo's "My data": the person's own file sources. */
export const FileSourcesPanel = () => {
  const navigate = useNavigate();
  const { data, error, isLoading } = useFileSources("mine");
  const [params, setParams] = useState<Record<string, string>>({});
  const q = params["filter[q]"]?.toLowerCase();
  const sources = data ?? [];
  const shown = sources.filter(
    (s) =>
      !q ||
      s.name.toLowerCase().includes(q) ||
      s.slug.toLowerCase().includes(q) ||
      s.tables.some((t) => t.name.includes(q))
  );

  return (
    <div className="z-my-narrow">
      <div className="z-list-toolbar">
        <div className="z-list-toolbar-filters">
          <TableFilters filters={FILTERS} onChange={setParams} />
        </div>
        <Button
          size="sm"
          fullWidth={false}
          onClick={() => navigate("/my/data/new")}
        >
          Add data
        </Button>
      </div>
      <ErrorNotice error={error} />
      {isLoading ? (
        <Spinner size="md" />
      ) : (
        <div className="z-actions-last">
          <Table<FileSource>
            rowKey={(s) => s.id}
            rows={shown}
            emptyMessage={
              error ? undefined : sources.length > 0 ? (
                <EmptyState>No sources match this search.</EmptyState>
              ) : (
                <EmptyState>
                  Upload a CSV or Excel file to query it and share it.
                </EmptyState>
              )
            }
            columns={[
              {
                title: "Name",
                cellElement: (s) => (
                  <span className="z-sources-name">
                    <TableCellLink as={Link} to={fileSourceHref(s.id)}>
                      {s.name}
                    </TableCellLink>
                    <code className="z-muted">{s.slug}</code>
                  </span>
                ),
              },
              {
                title: "Tables",
                cellElement: (s) => {
                  const names = s.tables
                    .filter((t) => !t.missing)
                    .map((t) => t.name);
                  return names.length > 0 ? (
                    <span className="z-fs-table-names">{names.join(", ")}</span>
                  ) : (
                    <span className="z-muted">None</span>
                  );
                },
              },
              {
                title: "Last loaded",
                cellElement: (s) => {
                  const iso = lastLoaded(s);
                  return iso ? (
                    <time dateTime={iso} title={formatDate(iso)}>
                      {formatRelative(iso)}
                    </time>
                  ) : (
                    <span className="z-muted">Never</span>
                  );
                },
              },
              {
                title: "Shared with",
                cellElement: (s) =>
                  s.share_count > 0 ? (
                    s.share_count.toLocaleString()
                  ) : (
                    <span className="z-muted">Not shared</span>
                  ),
              },
              {
                title: "Size",
                cellElement: (s) => formatBytes(s.stored_bytes),
              },
              {
                title: "",
                cellElement: (s) => (
                  <RowActions align="end">
                    <DeleteSource source={s} />
                  </RowActions>
                ),
              },
            ]}
          />
        </div>
      )}
    </div>
  );
};
