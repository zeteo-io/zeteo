import { ErrorNotice } from "@/components/ErrorNotice";
import { PageHeader } from "@/components/PageHeader";
import { Link, useNavigate } from "react-router-dom";
import { formatDate } from "@/utils/formatDate";
import { useSources } from "../api/useSources";
import { SourceStatus } from "./SourceStatus";
import { useEffect, useState } from "react";
import type { Source } from "../api/types";
import { useAuth } from "@tereo-io/react";
import "./styles.css";
import {
  Button,
  Checkbox,
  EmptyState,
  Spinner,
  Table,
  TableCellLink,
} from "@kosmeo-ui/react";

export const SourcesPage = () => {
  const { hasPermission } = useAuth();
  const navigate = useNavigate();
  const [includeArchived, setIncludeArchived] = useState(false);
  const { items, isLoading, error, hasMore, loadMore } = useSources({
    includeArchived,
  });

  // The list hook does not report a page in flight: wait for the list to change.
  const [loadingMore, setLoadingMore] = useState(false);
  useEffect(() => setLoadingMore(false), [items.length, hasMore, error]);

  return (
    <>
      <PageHeader
        title="Sources"
        subtitle="The databases zeteo can query"
        actions={
          hasPermission("zeteo.sources.write") && (
            <Button fullWidth={false} onClick={() => navigate("/sources/new")}>
              New source
            </Button>
          )
        }
      />
      <div className="z-sources-toolbar">
        <Checkbox
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
            error ? undefined : <EmptyState>No sources yet.</EmptyState>
          }
          columns={[
            {
              title: "Name",
              cellElement: (source) => (
                <TableCellLink as={Link} to={`/sources/${source.id}`}>
                  {source.name}
                </TableCellLink>
              ),
            },
            {
              title: "Slug",
              cellElement: (source) => <code>{source.slug}</code>,
            },
            { title: "Type", dataKey: "type" },
            {
              title: "Status",
              cellElement: (source) => <SourceStatus source={source} />,
            },
            {
              title: "Last refreshed",
              cellElement: (source) => formatDate(source.last_refreshed_at),
            },
          ]}
          rows={items}
        />
      )}
      {hasMore && (
        <div className="z-sources-more">
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
