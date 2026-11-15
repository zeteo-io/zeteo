import { useAllTables, useCanEditCatalogue } from "@/features/tables";
import { useDeleteRelation } from "../api/useDeleteRelation";
import { ConfirmButton } from "@/components/ConfirmButton";
import { ErrorNotice } from "@/components/ErrorNotice";
import { useRelations } from "../api/useRelations";
import { useUuidParam } from "@/lib/useUuidParam";
import { NotFound } from "@/components/NotFound";
import { RelationForm } from "./RelationForm";
import type { Relation } from "../api/types";
import { useState } from "react";
import "./styles.css";
import {
  Badge,
  Button,
  EmptyState,
  Spinner,
  Table as DataTable,
} from "@kosmeo-ui/react";

export const RelationsPage = () => {
  const sourceId = useUuidParam("sourceId");
  return sourceId ? <Relations sourceId={sourceId} /> : <NotFound />;
};

const Relations = ({ sourceId }: { sourceId: string }) => {
  const { items, isLoading, error, hasMore, loadMore } = useRelations(sourceId);
  const {
    tables,
    labelFor,
    isLoading: tablesLoading,
    error: tablesError,
  } = useAllTables(sourceId);
  const canEdit = useCanEditCatalogue(sourceId);
  const del = useDeleteRelation(sourceId);
  const [declaring, setDeclaring] = useState(false);

  const sides = (tableId: string, columns: string[]) => (
    <>
      {tablesLoading ? "…" : labelFor(tableId)}{" "}
      <code>({columns.join(", ")})</code>
    </>
  );

  return (
    <>
      {canEdit && !declaring && (
        <div className="z-relations-toolbar">
          <Button
            fullWidth={false}
            disabled={tablesLoading || !!tablesError}
            onClick={() => setDeclaring(true)}
          >
            Declare relation
          </Button>
        </div>
      )}
      {canEdit && declaring && (
        <RelationForm
          sourceId={sourceId}
          tables={tables.filter((t) => !t.missing_since)}
          onDeclared={() => setDeclaring(false)}
          onClose={() => setDeclaring(false)}
        />
      )}
      <ErrorNotice error={error} />
      <ErrorNotice error={tablesError} />
      {isLoading ? (
        <Spinner size="lg" />
      ) : (
        <div className="z-wrap">
          <DataTable<Relation>
            rowKey={(relation) => relation.id}
            emptyMessage={
              error ? undefined : <EmptyState>No relations yet.</EmptyState>
            }
            columns={[
              {
                title: "Name",
                cellElement: (relation) => (
                  <>
                    {relation.name}{" "}
                    {relation.missing_since && (
                      <Badge size="sm" variant="warning">
                        Missing
                      </Badge>
                    )}
                  </>
                ),
              },
              {
                title: "From",
                cellElement: (r) => sides(r.from_table_id, r.from_columns),
              },
              {
                title: "To",
                cellElement: (r) => sides(r.to_table_id, r.to_columns),
              },
              {
                title: "To many",
                cellElement: (r) => (r.to_many ? "Yes" : "No"),
              },
              { title: "Origin", dataKey: "origin" },
              ...(canEdit
                ? [
                    {
                      title: "",
                      cellElement: (r: Relation) =>
                        r.origin === "declared" ? (
                          <ConfirmButton
                            danger
                            label="Delete"
                            confirmTitle="Delete this relation?"
                            confirmText={`Queries can no longer join through ${r.name}. Grants are not affected.`}
                            confirmLabel="Delete relation"
                            onConfirm={() => del.mutateAsync(r.id)}
                          />
                        ) : null,
                    },
                  ]
                : []),
            ]}
            rows={items}
          />
        </div>
      )}
      {hasMore && (
        <div className="z-relations-more">
          <Button variant="secondary" fullWidth={false} onClick={loadMore}>
            Load more
          </Button>
        </div>
      )}
    </>
  );
};
