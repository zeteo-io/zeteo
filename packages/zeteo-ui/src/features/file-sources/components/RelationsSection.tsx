import type { Table as CatalogTable } from "@/features/tables";
import { faTrash } from "@fortawesome/free-solid-svg-icons";
import { ConfirmButton } from "@/components/ConfirmButton";
import { ErrorNotice } from "@/components/ErrorNotice";
import { EditButton } from "@/components/EditButton";
import type { FileSource } from "../api/types";
import { nameProblem } from "./PreviewEditor";
import { useState } from "react";
import {
  RelationForm,
  useAllRelations,
  useDeleteRelation,
  useRenameRelation,
  type Relation,
} from "@/features/relations";
import {
  Badge,
  Button,
  EmptyState,
  Input,
  Modal,
  RowActions,
  Spinner,
  Table,
} from "@kosmeo-ui/react";

/** The source's live tables in the shape the relation form picks from. */
const catalogTables = (source: FileSource): CatalogTable[] =>
  source.tables
    .filter((t) => !t.missing)
    .map((t) => ({
      id: t.id,
      source_id: source.id,
      schema_name: "",
      name: t.name,
      kind: "table",
      description: t.description,
      last_seen_at: t.last_synced_at ?? source.created_at,
      missing_since: null,
    }));

const RenameRelationDialog = ({
  sourceId,
  relation,
  onClose,
}: {
  sourceId: string;
  relation: Relation;
  onClose: () => void;
}) => {
  const rename = useRenameRelation(sourceId);
  const [name, setName] = useState(relation.name);
  const problem = nameProblem(name);
  return (
    <Modal
      show
      title="Rename relation"
      onClose={onClose}
      dismissible={!rename.isPending}
      footerButtons={[
        <Button
          key="cancel"
          variant="secondary"
          fullWidth={false}
          disabled={rename.isPending}
          onClick={onClose}
        >
          Cancel
        </Button>,
        <Button
          key="rename"
          fullWidth={false}
          isLoading={rename.isPending}
          disabled={rename.isPending || !!problem || name === relation.name}
          onClick={() =>
            rename.mutate({ id: relation.id, name }, { onSuccess: onClose })
          }
        >
          Rename
        </Button>,
      ]}
    >
      <div className="z-fs-dialog">
        <Input
          label="Name"
          value={name}
          error={problem}
          onChange={(e) => setName(e.target.value)}
        />
        <p className="z-note">
          Queries join through a relation by its name, so saved queries using
          the old name stop working.
        </p>
        <ErrorNotice error={rename.error} />
      </div>
    </Modal>
  );
};

const RemoveRelation = ({
  sourceId,
  relation,
}: {
  sourceId: string;
  relation: Relation;
}) => {
  const remove = useDeleteRelation(sourceId);
  return (
    <ConfirmButton
      danger
      size="sm"
      icon={faTrash}
      label="Delete"
      confirmTitle="Remove relation"
      confirmText={`Remove the relation ${relation.name}? Queries that join through it stop working.`}
      confirmLabel="Remove relation"
      onConfirm={() => remove.mutateAsync(relation.id)}
    />
  );
};

interface RelationsSectionProps {
  source: FileSource;
  canManage: boolean;
}

/** The relations declared between the source's tables: how queries join them. */
export const RelationsSection = ({
  source,
  canManage,
}: RelationsSectionProps) => {
  const { relations, error, isLoading } = useAllRelations(source.id);
  const [dialog, setDialog] = useState<
    { kind: "declare" } | { kind: "rename"; relation: Relation } | null
  >(null);
  const close = () => setDialog(null);
  const tableName = (id: string) =>
    source.tables.find((t) => t.id === id)?.name ?? id;
  const side = (tableId: string, columns: string[]) => (
    <span>
      {tableName(tableId)}
      <span className="z-muted"> ({columns.join(", ")})</span>
    </span>
  );
  const live = source.tables.filter((t) => !t.missing);

  return (
    <div className="z-my-narrow">
      <div className="z-list-toolbar">
        <p className="z-list-toolbar-filters z-note">
          A relation lets a query join one table to another by matching columns.
        </p>
        {canManage && (
          <Button
            size="sm"
            fullWidth={false}
            disabled={live.length === 0}
            onClick={() => setDialog({ kind: "declare" })}
          >
            Declare relation
          </Button>
        )}
      </div>
      <ErrorNotice error={error} />
      {isLoading ? (
        <Spinner size="md" />
      ) : (
        <div className={canManage ? "z-actions-last" : undefined}>
          <Table<Relation>
            rowKey={(r) => r.id}
            rows={relations}
            emptyMessage={
              error ? undefined : <EmptyState>No relations yet.</EmptyState>
            }
            columns={[
              {
                title: "Name",
                cellElement: (r) => (
                  <>
                    <code>{r.name}</code>
                    {r.to_many && (
                      <>
                        {" "}
                        <Badge size="sm" variant="secondary">
                          Many
                        </Badge>
                      </>
                    )}
                    {r.missing_since && (
                      <>
                        {" "}
                        <Badge size="sm" variant="warning">
                          Missing
                        </Badge>
                      </>
                    )}
                  </>
                ),
              },
              {
                title: "From",
                cellElement: (r) => side(r.from_table_id, r.from_columns),
              },
              {
                title: "To",
                cellElement: (r) => side(r.to_table_id, r.to_columns),
              },
              ...(canManage
                ? [
                    {
                      title: "",
                      cellElement: (r: Relation) => (
                        <RowActions align="end">
                          <EditButton
                            onClick={() =>
                              setDialog({ kind: "rename", relation: r })
                            }
                          />
                          <RemoveRelation sourceId={source.id} relation={r} />
                        </RowActions>
                      ),
                    },
                  ]
                : []),
            ]}
          />
        </div>
      )}
      {dialog?.kind === "declare" && (
        <RelationForm
          sourceId={source.id}
          tables={catalogTables(source)}
          getTableLabel={(t) => t.name}
          onDeclared={close}
          onClose={close}
        />
      )}
      {dialog?.kind === "rename" && (
        <RenameRelationDialog
          sourceId={source.id}
          relation={dialog.relation}
          onClose={close}
        />
      )}
    </div>
  );
};
