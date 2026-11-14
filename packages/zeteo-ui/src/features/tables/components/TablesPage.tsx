import { ErrorNotice } from "@/components/ErrorNotice";
import { Link, useParams } from "react-router-dom";
import { useTables } from "../api/useTables";
import type { Table } from "../api/types";
import { useState } from "react";
import "./styles.css";
import {
  Badge,
  Button,
  Checkbox,
  EmptyState,
  Spinner,
  Table as DataTable,
  TableCellLink,
} from "@kosmeo-ui/react";

export const TablesPage = () => {
  const { sourceId = "" } = useParams();
  const [includeMissing, setIncludeMissing] = useState(false);
  const { items, isLoading, error, hasMore, loadMore } = useTables(sourceId, {
    includeMissing,
  });

  return (
    <>
      <div className="z-tables-toolbar">
        <Checkbox
          label="Show missing tables"
          checked={includeMissing}
          onChange={(e) => setIncludeMissing(e.target.checked)}
        />
      </div>
      <ErrorNotice error={error} />
      {isLoading ? (
        <Spinner size="lg" />
      ) : (
        <DataTable<Table>
          rowKey={(table) => table.id}
          emptyMessage={
            error ? undefined : (
              <EmptyState>
                No tables yet. Refresh the source to read its catalogue.
              </EmptyState>
            )
          }
          columns={[
            { title: "Schema", dataKey: "schema_name" },
            {
              title: "Name",
              cellElement: (table) => (
                <>
                  <TableCellLink
                    as={Link}
                    to={`/sources/${sourceId}/tables/${table.id}`}
                  >
                    {table.name}
                  </TableCellLink>{" "}
                  {table.missing_since && (
                    <Badge size="sm" variant="warning">
                      Missing
                    </Badge>
                  )}
                </>
              ),
            },
            {
              title: "Kind",
              cellElement: (table) =>
                table.kind === "view" ? "View" : "Table",
            },
            {
              title: "Description",
              cellElement: (table) => table.description ?? "",
            },
          ]}
          rows={items}
        />
      )}
      {hasMore && (
        <div className="z-tables-more">
          <Button variant="secondary" fullWidth={false} onClick={loadMore}>
            Load more
          </Button>
        </div>
      )}
    </>
  );
};
