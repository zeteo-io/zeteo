import { PeoplePicker } from "@/features/saved-queries/components/PeoplePicker";
import { faUser, faUserGroup } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { useAllSources, type Source } from "@/features/sources";
import { ExistingGrantNotice } from "./ExistingGrantNotice";
import { useReplaceGrant } from "../api/useReplaceGrant";
import type { Grant, ReplaceGrant } from "../api/types";
import { useCreateGrant } from "../api/useCreateGrant";
import { ErrorNotice } from "@/components/ErrorNotice";
import { useAuth } from "@tereo-io/react";
import { useState } from "react";
import "./styles.css";
import {
  PrincipalCell,
  PrincipalPicker,
  type PrincipalRef,
} from "@/features/principals";
import {
  tableLabel,
  useAllTables,
  useTable,
  type Table,
} from "@/features/tables";
import {
  Alert,
  BorderedSection,
  Button,
  FormGrid,
  Modal,
  SearchSelect,
  Switch,
} from "@kosmeo-ui/react";
import {
  ColumnChooser,
  isValidChoice,
  type ChooserColumn,
  type ColumnChoice,
} from "./ColumnChooser";

const NEEDS_SOURCES = "Choosing a table needs the Read sources permission.";
const NO_COLUMN_LIST =
  "Choosing columns needs the Read sources permission, so the table's columns cannot be listed.";

/** A table that can be shared, as the source's own list has it. */
export interface ShareableTable {
  id: string;
  name: string;
  missing: boolean;
}

/** The source a dialog opened from a source's page is fixed to. */
export interface FixedSource {
  id: string;
  /** Its tables, named as the source's page names them. */
  tables: ShareableTable[];
}

/** The person or group being granted, with what a search told of them. */
type Chosen = PrincipalRef & { name?: string | null; email?: string | null };

const toRequest = ({ allColumns, selected }: ColumnChoice): ReplaceGrant =>
  allColumns
    ? { all_columns: true }
    : { all_columns: false, column_ids: selected };

interface GrantDialogProps {
  /** Present when changing a grant: its person and table stay. */
  grant?: Grant;
  /** From a source's page: the source is not a choice, only its tables are. */
  source?: FixedSource;
  onClose: () => void;
}

/**
 * The one grant dialog, for the Grants page (the source is chosen) and a
 * source's Shared with tab (the source is fixed). An admin with
 * `zeteo.grants.write` picks from the directory; an upload's owner from
 * the people they may share with.
 */
export const GrantDialog = ({ grant, source, onClose }: GrantDialogProps) => {
  // A grant that already exists can be opened from the notice in its place.
  const [editing, setEditing] = useState(grant);
  return (
    <GrantDialogBody
      key={editing?.id ?? "new"}
      grant={editing}
      source={source}
      onClose={onClose}
      onEditExisting={setEditing}
    />
  );
};

interface BodyProps extends GrantDialogProps {
  onEditExisting: (grant: Grant) => void;
}

const GrantDialogBody = ({
  grant,
  source: fixed,
  onClose,
  onEditExisting,
}: BodyProps) => {
  const { hasPermission } = useAuth();
  const asAdmin = hasPermission("zeteo.grants.write");
  const canReadSources = hasPermission("zeteo.sources.read");
  const create = useCreateGrant();
  const replace = useReplaceGrant(grant?.id ?? "");
  const mutation = grant ? replace : create;

  const fixedTables = (fixed?.tables ?? []).filter((t) => !t.missing);
  const [principal, setPrincipal] = useState<Chosen | null>(null);
  const [sourceId, setSourceId] = useState("");
  const [tableId, setTableId] = useState(
    fixedTables.length === 1 ? fixedTables[0]!.id : ""
  );
  const [choice, setChoice] = useState<ColumnChoice>({
    allColumns: grant?.all_columns ?? true,
    selected: grant?.columns.map((c) => c.id) ?? [],
  });

  const activeSourceId = grant?.source.id ?? fixed?.id ?? sourceId;
  const activeTableId = grant?.table.id ?? tableId;
  // From a source's page, its tables are given; otherwise they are read.
  const choosing = !grant && !fixed;
  const sources = useAllSources(choosing && canReadSources);
  const tables = useAllTables(
    choosing && canReadSources && sourceId ? sourceId : undefined
  );
  // The source's page could show its tables, so it can list their columns.
  const canListColumns = !!fixed || canReadSources;
  const table = useTable(
    canListColumns && activeTableId ? activeSourceId : undefined,
    canListColumns && activeTableId ? activeTableId : undefined
  );

  const liveColumns: ChooserColumn[] = (table.data?.columns ?? [])
    .filter((c) => !c.missing_since)
    .map((c) => ({ id: c.id, name: c.name, missing: false }));
  // What the grant still holds of columns the table lost stays listed.
  const columns: ChooserColumn[] = [
    ...liveColumns,
    ...(grant?.columns ?? []).filter(
      (held) => !liveColumns.some((c) => c.id === held.id)
    ),
  ];

  const choosePrincipal = (p: Chosen | null) => {
    create.reset();
    setPrincipal(p);
  };
  const chooseSource = (id: string) => {
    create.reset();
    setSourceId(id);
    setTableId("");
    setChoice((c) => ({ ...c, selected: [] }));
  };
  const chooseTable = (id: string) => {
    create.reset();
    setTableId(id);
    setChoice((c) => ({ ...c, selected: [] }));
  };

  const ready = grant ? true : !!principal && !!tableId;
  const canSubmit = ready && isValidChoice(choice) && !mutation.isPending;

  const submit = () => {
    if (!canSubmit) return;
    // Waits on the request itself: callbacks given to mutate are dropped if
    // the mutation is reset meanwhile, and the dialog would never close.
    const saved = grant
      ? replace.mutateAsync(toRequest(choice))
      : principal &&
        create.mutateAsync({
          principal_type: principal.type,
          principal_id: principal.id,
          table_id: tableId,
          ...toRequest(choice),
        });
    if (!saved) return;
    // The mutation's own error state shows a failure.
    saved.then(onClose, () => undefined);
  };

  const selectsFailed = !canReadSources || sources.error?.status === 403;
  const sourceName = (id: string, slug: string) =>
    sources.sources.find((x) => x.id === id)?.name ?? slug;

  const title = fixed
    ? grant
      ? "Change what is shared"
      : "Share a table"
    : grant
      ? "Edit grant"
      : "New grant";
  const submitLabel = fixed
    ? grant
      ? "Save"
      : "Share"
    : grant
      ? "Save grant"
      : "Create grant";

  const who = grant ? (
    <PrincipalCell
      principal_type={grant.principal_type}
      principal_id={grant.principal_id}
      status={grant.principal_status}
    />
  ) : asAdmin ? (
    <PrincipalPicker value={principal} onChange={choosePrincipal} />
  ) : principal ? (
    <p className="z-principal-cell z-grant-table">
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
        onClick={() => choosePrincipal(null)}
      >
        ×
      </button>
    </p>
  ) : (
    <PeoplePicker onPick={choosePrincipal} />
  );

  const tablePart = grant ? (
    <>
      <p className="z-grant-table">
        {fixed ? (
          (fixed.tables.find((t) => t.id === grant.table.id)?.name ??
          grant.table.name)
        ) : (
          <>
            {sourceName(grant.source.id, grant.source.slug)}
            <span className="z-muted"> · </span>
            <span className="z-muted">{grant.table.schema_name}.</span>
            {grant.table.name}
          </>
        )}
      </p>
      {grant.table.missing && (
        <Alert variant="warning">
          The last refresh no longer found this table. The grant is kept.
        </Alert>
      )}
    </>
  ) : fixed ? (
    <SearchSelect<ShareableTable>
      label="Table"
      placeholder="Search tables"
      value={fixedTables.find((t) => t.id === tableId) ?? null}
      options={fixedTables}
      getOptionLabel={(t) => t.name}
      getOptionKey={(t) => t.id}
      longDropDown
      onSelect={(t) => chooseTable(t.id)}
    />
  ) : selectsFailed ? (
    <Alert variant="warning">{NEEDS_SOURCES}</Alert>
  ) : (
    <>
      <ErrorNotice error={sources.error} />
      <FormGrid columns={2}>
        <SearchSelect<Source>
          label="Source"
          placeholder="Search sources"
          value={sources.sources.find((x) => x.id === sourceId) ?? null}
          options={sources.sources.filter((x) => !x.archived_at)}
          getOptionLabel={(x) => x.name}
          getOptionKey={(x) => x.id}
          disabled={sources.isLoading}
          onSelect={(x) => chooseSource(x.id)}
        />
        <SearchSelect<Table>
          label="Table"
          placeholder={sourceId ? "Search tables" : "Choose a source first"}
          value={tables.tables.find((t) => t.id === tableId) ?? null}
          options={tables.tables.filter((t) => !t.missing_since)}
          getOptionLabel={(t) => tableLabel(t)}
          getOptionKey={(t) => t.id}
          disabled={!sourceId || tables.isLoading}
          longDropDown
          onSelect={(t) => chooseTable(t.id)}
        />
      </FormGrid>
      <ErrorNotice error={tables.error} />
    </>
  );

  return (
    <Modal
      show
      size="lg"
      title={title}
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
          key="submit"
          fullWidth={false}
          isLoading={mutation.isPending}
          disabled={!canSubmit}
          onClick={submit}
        >
          {submitLabel}
        </Button>,
      ]}
    >
      <div className="z-grant-form">
        <BorderedSection title="Who" as="h2">
          {who}
        </BorderedSection>
        <BorderedSection title="Table" as="h2">
          {tablePart}
        </BorderedSection>
        {(grant || tableId) && (
          <BorderedSection
            title="Columns"
            as="h2"
            actions={
              <Switch
                size="sm"
                label="All columns"
                checked={choice.allColumns}
                onChange={(e) =>
                  setChoice({ ...choice, allColumns: e.target.checked })
                }
              />
            }
          >
            {choice.allColumns ? (
              <p className="z-muted z-grant-note">
                Every column of the table, including columns added later.
              </p>
            ) : (
              <ColumnChooser
                showMode={false}
                value={choice}
                onChange={setChoice}
                columns={columns}
                loading={table.isLoading}
                unavailable={
                  !canListColumns
                    ? NO_COLUMN_LIST
                    : table.error
                      ? table.error.message
                      : undefined
                }
              />
            )}
          </BorderedSection>
        )}
        {!grant && mutation.error?.code === "grant_exists" && principal ? (
          <ExistingGrantNotice
            principal={principal}
            sourceId={activeSourceId}
            tableId={tableId}
            error={mutation.error}
            onEdit={onEditExisting}
          />
        ) : (
          <ErrorNotice error={mutation.error} />
        )}
      </div>
    </Modal>
  );
};
