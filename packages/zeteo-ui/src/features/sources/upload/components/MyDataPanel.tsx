import { fromPage, MY_DATA_BACK } from "../../components/sourceBack";
import { useDeleteUploadSource, useMyUploads } from "../api/uploads";
import { faTrash } from "@fortawesome/free-solid-svg-icons";
import { sourceHref } from "../../components/sourceLabels";
import { ConfirmButton } from "@/components/ConfirmButton";
import { formatRelative } from "@/utils/formatRelative";
import { ErrorNotice } from "@/components/ErrorNotice";
import { ADD_DATA_HREF, formatBytes } from "./labels";
import { Link, useNavigate } from "react-router-dom";
import { formatDate } from "@/utils/formatDate";
import type { Source } from "../../api/types";
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

const DeleteSource = ({ source }: { source: Source }) => {
  const remove = useDeleteUploadSource();
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

/** My Zeteo's "My sources": the person's own upload sources. */
export const MyDataPanel = () => {
  const navigate = useNavigate();
  const { data, error, isLoading } = useMyUploads();
  const [params, setParams] = useState<Record<string, string>>({});
  const q = params["filter[q]"]?.toLowerCase();
  const sources = data ?? [];
  const shown = sources.filter(
    (s) =>
      !q || s.name.toLowerCase().includes(q) || s.slug.toLowerCase().includes(q)
  );

  return (
    <div>
      <div className="z-list-toolbar">
        <div className="z-list-toolbar-filters">
          <TableFilters filters={FILTERS} onChange={setParams} />
        </div>
        <Button
          size="sm"
          fullWidth={false}
          onClick={() => navigate(ADD_DATA_HREF)}
        >
          Add data
        </Button>
      </div>
      <ErrorNotice error={error} />
      {isLoading ? (
        <Spinner size="md" />
      ) : (
        <div className="z-actions-last">
          <Table<Source>
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
                    <TableCellLink
                      as={Link}
                      to={sourceHref(s.id)}
                      state={fromPage(MY_DATA_BACK)}
                    >
                      {s.name}
                    </TableCellLink>
                    <code className="z-muted">{s.slug}</code>
                  </span>
                ),
              },
              {
                title: "Size",
                cellElement: (s) =>
                  s.size_bytes === null ? (
                    <span className="z-muted">—</span>
                  ) : (
                    formatBytes(s.size_bytes)
                  ),
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
                title: "Added",
                cellElement: (s) => (
                  <time
                    dateTime={s.created_at}
                    title={formatDate(s.created_at)}
                  >
                    {formatRelative(s.created_at)}
                  </time>
                ),
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
