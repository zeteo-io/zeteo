import { GrantDialog, type ShareableTable } from "./GrantDialog";
import { faTrash } from "@fortawesome/free-solid-svg-icons";
import { ConfirmButton } from "@/components/ConfirmButton";
import { ErrorNotice } from "@/components/ErrorNotice";
import { useDeleteGrant } from "../api/useDeleteGrant";
import { EditButton } from "@/components/EditButton";
import { useGrants } from "../api/useGrants";
import type { Grant } from "../api/types";
import { useMemo, useState } from "react";
import { useAuth } from "@tereo-io/react";
import "./styles.css";
import {
  PrincipalCell,
  parseWho,
  useDirectory,
  whoFilter,
} from "@/features/principals";
import {
  Badge,
  Button,
  EmptyState,
  RowActions,
  Spinner,
  Table,
  TableFilters,
  type InfiniteScrollMenuFilter,
} from "@kosmeo-ui/react";

const columnsText = (grant: Grant) =>
  grant.all_columns
    ? "All columns"
    : grant.columns.map((c) => c.name).join(", ") || "—";

const DeleteGrant = ({ grant }: { grant: Grant }) => {
  const del = useDeleteGrant();
  return (
    <ConfirmButton
      danger
      size="sm"
      icon={faTrash}
      label="Stop sharing"
      confirmTitle="Stop sharing this table?"
      confirmText={`They will no longer be able to query ${grant.table.name} through this grant.`}
      confirmLabel="Stop sharing"
      onConfirm={() => del.mutateAsync(grant.id)}
    />
  );
};

interface SourceGrantsProps {
  sourceId: string;
  /** The source's tables, to choose from when sharing. */
  tables: ShareableTable[];
  /** Shares and changes grants: an admin with `zeteo.grants.write`, or an upload source's owner. */
  canShare: boolean;
  /** Removes grants: as `canShare`, or a grants admin once the source is deleted. */
  canRemove: boolean;
}

/** A source's "Shared with" tab: every grant on its tables, an upload source's owner's own included. */
export const SourceGrants = ({
  sourceId,
  tables,
  canShare,
  canRemove,
}: SourceGrantsProps) => {
  const [params, setParams] = useState<Record<string, string>>({});
  const tableId = params["filter[table]"];
  const who = parseWho(params);
  const { items, isLoading, error, hasMore, loadMore } = useGrants({
    source_id: sourceId,
    ...(tableId && { table_id: tableId }),
    ...who,
  });
  const filtered = !!tableId || "principal_id" in who;

  // Who: the whole directory, so anyone can be picked, shared with or not.
  // A grants reader sees everyone; an upload's owner, whoever they may share with.
  const { hasPermission } = useAuth();
  const directory = useDirectory(
    hasPermission("zeteo.grants.read") ? "admin" : "mine"
  );
  // The filters wait for the directory: a filter's choices changing would
  // reset what is chosen in it. Without it, the Table filter still shows.
  const filtersReady = !directory.isLoading;
  // A stable key, so the filters (and what is chosen in them) reset only
  // when the source's tables really change.
  const tableKey = tables
    .filter((t) => !t.missing)
    .map((t) => `${t.id}\t${t.name}`)
    .join("\n");
  const filters = useMemo<InfiniteScrollMenuFilter[]>(
    () => [
      ...(directory.data ? [whoFilter(directory.data.data)] : []),
      {
        type: "SELECT",
        title: "Table",
        dataKey: "table",
        options: (tableKey ? tableKey.split("\n") : []).map((line) => {
          const [id, name] = line.split("\t");
          return { id: id!, name: name!, selected: false };
        }),
      },
    ],
    [tableKey, directory.data]
  );
  const [dialog, setDialog] = useState<{ grant?: Grant } | null>(null);
  // An owner's grant is locked, so a list of only those has no actions.
  const withActions = canRemove && items.some((g) => !g.owner_grant);

  return (
    <>
      <div className="z-list-toolbar z-list-toolbar-top">
        <div className="z-list-toolbar-filters">
          {filtersReady && (
            <TableFilters filters={filters} onChange={setParams} />
          )}
        </div>
        {canShare && (
          <Button
            size="sm"
            fullWidth={false}
            disabled={tables.every((t) => t.missing)}
            onClick={() => setDialog({})}
          >
            Share
          </Button>
        )}
      </div>
      <ErrorNotice error={directory.error} />
      <ErrorNotice error={error} />
      {isLoading ? (
        <Spinner size="md" />
      ) : (
        <div className={withActions ? "z-actions-last" : undefined}>
          <Table<Grant>
            rowKey={(g) => g.id}
            rows={items}
            emptyMessage={
              error ? undefined : (
                <EmptyState>
                  {filtered
                    ? "No one matches these filters."
                    : "Not shared with anyone yet."}
                </EmptyState>
              )
            }
            columns={[
              {
                title: "Who",
                cellElement: (g) => (
                  <>
                    <PrincipalCell
                      principal_type={g.principal_type}
                      principal_id={g.principal_id}
                      status={g.principal_status}
                    />
                    {g.owner_grant && (
                      <>
                        {" "}
                        <Badge size="sm" variant="secondary">
                          Owner
                        </Badge>
                      </>
                    )}
                  </>
                ),
              },
              {
                title: "Table",
                cellElement: (g) => (
                  <>
                    {g.table.name}
                    {g.table.missing && (
                      <>
                        {" "}
                        <Badge size="sm" variant="warning">
                          Removed
                        </Badge>
                      </>
                    )}
                  </>
                ),
              },
              { title: "Columns", cellElement: columnsText },
              ...(withActions
                ? [
                    {
                      title: "",
                      cellElement: (g: Grant) =>
                        g.owner_grant ? null : (
                          <RowActions align="end">
                            {canShare && (
                              <EditButton
                                onClick={() => setDialog({ grant: g })}
                              />
                            )}
                            <DeleteGrant grant={g} />
                          </RowActions>
                        ),
                    },
                  ]
                : []),
            ]}
          />
        </div>
      )}
      {hasMore && (
        <div className="z-my-more">
          <Button
            size="sm"
            variant="secondary"
            fullWidth={false}
            onClick={loadMore}
          >
            Load more
          </Button>
        </div>
      )}
      {dialog && (
        <GrantDialog
          source={{ id: sourceId, tables }}
          grant={dialog.grant}
          onClose={() => setDialog(null)}
        />
      )}
    </>
  );
};
