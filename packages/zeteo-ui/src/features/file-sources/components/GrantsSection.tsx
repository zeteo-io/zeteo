import { PeoplePicker } from "@/features/saved-queries/components/PeoplePicker";
import { PrincipalCell, type Principal } from "@/features/principals";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import type { FileSource, FileSourceTable } from "../api/types";
import { ConfirmButton } from "@/components/ConfirmButton";
import { ErrorNotice } from "@/components/ErrorNotice";
import { EditButton } from "@/components/EditButton";
import { useState } from "react";
import {
  faTrash,
  faUser,
  faUserGroup,
} from "@fortawesome/free-solid-svg-icons";
import {
  ColumnChooser,
  isValidChoice,
  useCreateGrant,
  useDeleteGrant,
  useGrants,
  useReplaceGrant,
  type ColumnChoice,
  type Grant,
} from "@/features/grants";
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
} from "@kosmeo-ui/react";

const columnsText = (grant: Grant) =>
  grant.all_columns
    ? "All columns"
    : grant.columns.map((c) => c.name).join(", ") || "—";

interface ShareDialogProps {
  source: FileSource;
  /** Present when changing a grant: its person and table stay. */
  grant?: Grant;
  onClose: () => void;
}

/** Shares a table of the source with a person or group: every column or a chosen few. */
const ShareDialog = ({ source, grant, onClose }: ShareDialogProps) => {
  const create = useCreateGrant();
  const replace = useReplaceGrant(grant?.id ?? "");
  const mutation = grant ? replace : create;
  const tables = source.tables.filter((t) => !t.missing);
  const [principal, setPrincipal] = useState<Principal | null>(null);
  const [tableId, setTableId] = useState(
    grant?.table.id ?? (tables.length === 1 ? tables[0]!.id : "")
  );
  const [choice, setChoice] = useState<ColumnChoice>({
    allColumns: grant?.all_columns ?? true,
    selected: grant?.columns.map((c) => c.id) ?? [],
  });
  const table = source.tables.find((t) => t.id === tableId);
  const columns = (table?.columns ?? [])
    .filter((c) => !c.missing)
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
          <SearchSelect<FileSourceTable>
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

interface GrantsSectionProps {
  source: FileSource;
  /** Shares and changes grants: the owner, or an admin with `zeteo.grants.write`. */
  canShare: boolean;
  /** Removes grants: as `canShare`, or a grants admin once the source is deleted. */
  canRemove: boolean;
}

/** "Shared with": every grant on the source's tables, the owner's own included. */
export const GrantsSection = ({
  source,
  canShare,
  canRemove,
}: GrantsSectionProps) => {
  const { items, isLoading, error, hasMore, loadMore } = useGrants({
    source_id: source.id,
  });
  const [dialog, setDialog] = useState<{ grant?: Grant } | null>(null);

  return (
    <div className="z-my-narrow">
      <div className="z-list-toolbar">
        <div className="z-list-toolbar-filters" />
        {canShare && (
          <Button
            size="sm"
            fullWidth={false}
            disabled={source.tables.every((t) => t.missing)}
            onClick={() => setDialog({})}
          >
            Share
          </Button>
        )}
      </div>
      <ErrorNotice error={error} />
      {isLoading ? (
        <Spinner size="md" />
      ) : (
        <div className={canRemove ? "z-actions-last" : undefined}>
          <Table<Grant>
            rowKey={(g) => g.id}
            rows={items}
            emptyMessage={
              error ? undefined : (
                <EmptyState>Not shared with anyone yet.</EmptyState>
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
              ...(canRemove
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
          source={source}
          grant={dialog.grant}
          onClose={() => setDialog(null)}
        />
      )}
    </div>
  );
};
