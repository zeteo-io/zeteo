import { PeoplePicker } from "@/features/saved-queries/components/PeoplePicker";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { ConfirmButton } from "@/components/ConfirmButton";
import { useTable } from "@/features/tables/api/useTable";
import { useReplaceGrant } from "../api/useReplaceGrant";
import { ErrorNotice } from "@/components/ErrorNotice";
import { useCreateGrant } from "../api/useCreateGrant";
import { useDeleteGrant } from "../api/useDeleteGrant";
import { EditButton } from "@/components/EditButton";
import { useGrants } from "../api/useGrants";
import type { Grant } from "../api/types";
import { useMemo, useState } from "react";
import { useAuth } from "@tereo-io/react";
import "./styles.css";
import {
  faTrash,
  faUser,
  faUserGroup,
} from "@fortawesome/free-solid-svg-icons";
import {
  PrincipalCell,
  parseWho,
  useDirectory,
  whoFilter,
  type Principal,
} from "@/features/principals";
import {
  Alert,
  Badge,
  Button,
  EmptyState,
  Modal,
  RowActions,
  SearchSelect,
  Spinner,
  Switch,
  Table,
  TableFilters,
  type InfiniteScrollMenuFilter,
} from "@kosmeo-ui/react";
import {
  ColumnChooser,
  isValidChoice,
  type ColumnChoice,
} from "./ColumnChooser";

const columnsText = (grant: Grant) =>
  grant.all_columns
    ? "All columns"
    : grant.columns.map((c) => c.name).join(", ") || "—";

/** A table that can be shared, as the source's own list has it. */
export interface ShareableTable {
  id: string;
  name: string;
  missing: boolean;
}

interface ShareDialogProps {
  sourceId: string;
  tables: ShareableTable[];
  /** Present when changing a grant: its person and table stay. */
  grant?: Grant;
  onClose: () => void;
}

/** Shares a table of the source with a person or group: every column or a chosen few. */
const ShareDialog = ({
  sourceId,
  tables: allTables,
  grant,
  onClose,
}: ShareDialogProps) => {
  const create = useCreateGrant();
  const replace = useReplaceGrant(grant?.id ?? "");
  const mutation = grant ? replace : create;
  const tables = allTables.filter((t) => !t.missing);
  const [principal, setPrincipal] = useState<Principal | null>(null);
  const [tableId, setTableId] = useState(
    grant?.table.id ?? (tables.length === 1 ? tables[0]!.id : "")
  );
  const [choice, setChoice] = useState<ColumnChoice>({
    allColumns: grant?.all_columns ?? true,
    selected: grant?.columns.map((c) => c.id) ?? [],
  });
  const table = tables.find((t) => t.id === tableId);
  // The chosen table's columns, from the catalogue.
  const detail = useTable(sourceId, tableId || undefined);
  const columns = (detail.data?.columns ?? [])
    .filter((c) => !c.missing_since)
    .map((c) => ({ id: c.id, name: c.name, missing: false }));
  // Columns the grant holds that the table lost stay listed, ticked.
  const held = (grant?.columns ?? []).filter(
    (c) => !columns.some((x) => x.id === c.id)
  );

  const ready =
    (grant || (principal && tableId)) &&
    isValidChoice(choice) &&
    !mutation.isPending;
  const body = choice.allColumns
    ? { all_columns: true as const }
    : { all_columns: false as const, column_ids: choice.selected };

  const submit = () => {
    if (!ready) return;
    if (grant) replace.mutate(body, { onSuccess: onClose });
    else if (principal) {
      create.mutate(
        {
          principal_type: principal.type,
          principal_id: principal.id,
          table_id: tableId,
          ...body,
        },
        { onSuccess: onClose }
      );
    }
  };

  return (
    <Modal
      show
      size="lg"
      title={grant ? "Change what is shared" : "Share a table"}
      onClose={onClose}
      dismissible={!mutation.isPending}
      footerButtons={[
        <Button
          key="cancel"
          variant="secondary"
          fullWidth={false}
          disabled={mutation.isPending}
          onClick={onClose}
        >
          Cancel
        </Button>,
        <Button
          key="share"
          fullWidth={false}
          isLoading={mutation.isPending}
          disabled={!ready}
          onClick={submit}
        >
          {grant ? "Save" : "Share"}
        </Button>,
      ]}
    >
      <div className="z-fs-dialog">
        {grant ? (
          <PrincipalCell
            principal_type={grant.principal_type}
            principal_id={grant.principal_id}
            status={grant.principal_status}
          />
        ) : principal ? (
          <p className="z-principal-cell">
            <FontAwesomeIcon
              className="z-principal-icon"
              icon={principal.type === "group" ? faUserGroup : faUser}
            />
            {principal.name ?? principal.id}
            {principal.email && (
              <span className="z-principal-email">{principal.email}</span>
            )}
            <button
              type="button"
              className="z-chip-clear"
              aria-label="Choose someone else"
              onClick={() => setPrincipal(null)}
            >
              ×
            </button>
          </p>
        ) : (
          <PeoplePicker onPick={setPrincipal} />
        )}
        {grant ? (
          <p>
            Table <strong>{grant.table.name}</strong>
          </p>
        ) : (
          <SearchSelect<ShareableTable>
            label="Table"
            placeholder="Choose a table"
            value={table ?? null}
            options={tables}
            getOptionLabel={(t) => t.name}
            getOptionKey={(t) => t.id}
            onSelect={(t) => {
              setTableId(t.id);
              setChoice((c) => ({ ...c, selected: [] }));
            }}
          />
        )}
        {(grant || table) && (
          <>
            <Switch
              size="sm"
              label="All columns"
              checked={choice.allColumns}
              onChange={(e) =>
                setChoice({ ...choice, allColumns: e.target.checked })
              }
            />
            {choice.allColumns ? (
              <p className="z-note">
                Every column of the table, including columns added later.
              </p>
            ) : (
              <ColumnChooser
                showMode={false}
                value={choice}
                onChange={setChoice}
                columns={[...columns, ...held]}
              />
            )}
          </>
        )}
        {mutation.error?.code === "grant_exists" ? (
          <Alert variant="warning">
            They already have access to this table. Change that grant in the
            list instead.
          </Alert>
        ) : (
          <ErrorNotice error={mutation.error} />
        )}
      </div>
    </Modal>
  );
};

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
  /** Shares and changes grants: an admin with `zeteo.grants.write`, or a file source's owner. */
  canShare: boolean;
  /** Removes grants: as `canShare`, or a grants admin once the source is deleted. */
  canRemove: boolean;
}

/** A source's "Shared with" tab: every grant on its tables, a file source's owner's own included. */
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
        <ShareDialog
          sourceId={sourceId}
          tables={tables}
          grant={dialog.grant}
          onClose={() => setDialog(null)}
        />
      )}
    </>
  );
};
