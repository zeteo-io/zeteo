import { sourceHref, sourceTypeName } from "./sourceLabels";
import { formatRelative } from "@/utils/formatRelative";
import { ErrorNotice } from "@/components/ErrorNotice";
import { PrincipalLabel } from "@/features/principals";
import { fromPage, SOURCES_BACK } from "./sourceBack";
import { useAllSources } from "../api/useAllSources";
import { PageHeader } from "@/components/PageHeader";
import { Link, useNavigate } from "react-router-dom";
import { formatDate } from "@/utils/formatDate";
import { SourceStatus } from "./SourceStatus";
import type { Source } from "../api/types";
import { useAuth } from "@tereo-io/react";
import { useState } from "react";
import "./styles.css";
import {
  Button,
  EmptyState,
  Spinner,
  Switch,
  Table,
  TableCellLink,
  TableFilters,
  type InfiniteScrollMenuFilter,
} from "@kosmeo-ui/react";

const FILTERS: InfiniteScrollMenuFilter[] = [
  { type: "SEARCH", title: "Search", dataKey: "q" },
  {
    type: "SELECT",
    title: "Kind",
    dataKey: "type",
    options: [
      { id: "postgres", name: "PostgreSQL", selected: false },
      { id: "azure-sql", name: "Azure SQL", selected: false },
      { id: "upload", name: "Upload", selected: false },
    ],
  },
];

export const SourcesPage = () => {
  const { hasPermission } = useAuth();
  const navigate = useNavigate();
  const [includeArchived, setIncludeArchived] = useState(false);
  const [params, setParams] = useState<Record<string, string>>({});
  const { sources, isLoading, error } = useAllSources(true);

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
      <PageHeader title="Sources" divider={false} />
      <div className="z-list-toolbar">
        <div className="z-list-toolbar-filters">
          <TableFilters filters={FILTERS} onChange={setParams} />
        </div>
        {hasPermission("zeteo.sources.write") && (
          <Button
            size="sm"
            fullWidth={false}
            onClick={() => navigate("/sources/new")}
          >
            New source
          </Button>
        )}
        <Switch
          size="sm"
          label="Show archived"
          checked={includeArchived}
          onChange={(e) => setIncludeArchived(e.target.checked)}
        />
      </div>
      <ErrorNotice error={error} />
      {isLoading ? (
        <Spinner size="lg" />
      ) : (
        <Table<Source>
          rowKey={(source) => source.id}
          emptyMessage={
            error ? undefined : anyVisible ? (
              <EmptyState>No sources match these filters.</EmptyState>
            ) : (
              <EmptyState>
                No sources yet. Add one to let people query its tables.
              </EmptyState>
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
                    state={fromPage(SOURCES_BACK)}
                  >
                    {source.name}
                  </TableCellLink>
                  <code className="z-muted">{source.slug}</code>
                </span>
              ),
            },
            {
              title: "Kind",
              cellElement: (source) => sourceTypeName(source.type),
            },
            {
              title: "Owner",
              cellElement: (source) =>
                source.owner_id ? (
                  <PrincipalLabel
                    refValue={{ type: "user", id: source.owner_id }}
                  />
                ) : (
                  <span className="z-muted">—</span>
                ),
            },
            {
              title: "Status",
              width: "1%",
              cellElement: (source) => <SourceStatus source={source} />,
            },
            {
              title: "Last refreshed",
              cellElement: (source) =>
                source.last_refreshed_at ? (
                  <time title={formatDate(source.last_refreshed_at)}>
                    {formatRelative(source.last_refreshed_at)}
                  </time>
                ) : (
                  <span className="z-muted">Never</span>
                ),
            },
          ]}
          rows={shown}
        />
      )}
    </>
  );
};
