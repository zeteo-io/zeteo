import { PrincipalPicker, type PrincipalRef } from "@/features/principals";
import { useAllSources, type Source } from "@/features/sources";
import { ExistingGrantNotice } from "./ExistingGrantNotice";
import { useReplaceGrant } from "../api/useReplaceGrant";
import type { Grant, ReplaceGrant } from "../api/types";
import { useCreateGrant } from "../api/useCreateGrant";
import { ErrorNotice } from "@/components/ErrorNotice";
import { PrincipalCell } from "@/features/principals";
import { PageHeader } from "@/components/PageHeader";
import { useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "@tereo-io/react";
import "./styles.css";
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
  Form,
  FormGrid,
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

const toRequest = ({ allColumns, selected }: ColumnChoice): ReplaceGrant =>
  allColumns
    ? { all_columns: true }
    : { all_columns: false, column_ids: selected };

interface GrantFormProps {
  /** Present when editing: its principal and table are shown, not chosen. */
  grant?: Grant;
  /** The page title, shown with the form's buttons. */
  title: string;
  /** More header buttons, before Cancel (the edit page's Delete). */
  extraActions?: ReactNode;
}

const FORM_ID = "z-grant-form";

export const GrantForm = ({ grant, title, extraActions }: GrantFormProps) => {
  const navigate = useNavigate();
  const { hasPermission } = useAuth();
  const canReadSources = hasPermission("zeteo.sources.read");
  const create = useCreateGrant();
  const replace = useReplaceGrant(grant?.id ?? "");
  const mutation = grant ? replace : create;

  const [principal, setPrincipal] = useState<PrincipalRef | null>(null);
  const [sourceId, setSourceId] = useState("");
  const [tableId, setTableId] = useState("");
  const [choice, setChoice] = useState<ColumnChoice>({
    allColumns: grant?.all_columns ?? true,
    selected: grant?.columns.map((c) => c.id) ?? [],
  });

  const activeSourceId = grant ? grant.source.id : sourceId;
  const activeTableId = grant ? grant.table.id : tableId;
  const sources = useAllSources(!grant && canReadSources);
  const tables = useAllTables(
    !grant && canReadSources && sourceId ? sourceId : undefined
  );
  const table = useTable(
    canReadSources && activeTableId ? activeSourceId : undefined,
    canReadSources && activeTableId ? activeTableId : undefined
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

  const choosePrincipal = (p: PrincipalRef) => {
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
    const done = { onSuccess: () => navigate("/grants") };
    if (grant) {
      replace.mutate(toRequest(choice), done);
    } else if (principal) {
      create.mutate(
        {
          principal_type: principal.type,
          principal_id: principal.id,
          table_id: tableId,
          ...toRequest(choice),
        },
        done
      );
    }
  };

  const selectsFailed = !canReadSources || sources.error?.status === 403;

  const sourceName = (id: string, slug: string) =>
    sources.sources.find((x) => x.id === id)?.name ?? slug;

  return (
    <div className="z-grant-form">
      <PageHeader
        title={title}
        divider={false}
        actions={
          <div className="z-header-actions">
            {extraActions}
            <Button
              size="sm"
              variant="secondary"
              fullWidth={false}
              onClick={() => navigate("/grants")}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              type="submit"
              form={FORM_ID}
              fullWidth={false}
              isLoading={mutation.isPending}
              disabled={!canSubmit}
            >
              {grant ? "Save grant" : "Create grant"}
            </Button>
          </div>
        }
      />
      <Form id={FORM_ID} onSubmit={submit}>
        <BorderedSection title="Who" as="h2">
          {grant ? (
            <PrincipalCell
              principal_type={grant.principal_type}
              principal_id={grant.principal_id}
              status={grant.principal_status}
            />
          ) : (
            <PrincipalPicker value={principal} onChange={choosePrincipal} />
          )}
        </BorderedSection>

        <BorderedSection title="Table" as="h2">
          {grant ? (
            <>
              <p className="z-grant-table">
                {sourceName(grant.source.id, grant.source.slug)}
                <span className="z-muted"> · </span>
                <span className="z-muted">{grant.table.schema_name}.</span>
                {grant.table.name}
              </p>
              {grant.table.missing && (
                <Alert variant="warning">
                  The last refresh no longer found this table. The grant is
                  kept.
                </Alert>
              )}
            </>
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
                  placeholder={
                    sourceId ? "Search tables" : "Choose a source first"
                  }
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
          )}
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
                  !canReadSources
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
            tableId={tableId}
            error={mutation.error}
          />
        ) : (
          <ErrorNotice error={mutation.error} />
        )}
      </Form>
    </div>
  );
};
