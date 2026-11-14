import { Alert, Button, Form, FormActions, Select } from "@kosmeo-ui/react";
import { PrincipalPicker, type PrincipalRef } from "@/features/principals";
import { tableLabel, useAllTables, useTable } from "@/features/tables";
import { ExistingGrantNotice } from "./ExistingGrantNotice";
import { useReplaceGrant } from "../api/useReplaceGrant";
import type { Grant, ReplaceGrant } from "../api/types";
import { useCreateGrant } from "../api/useCreateGrant";
import { ErrorNotice } from "@/components/ErrorNotice";
import { Link, useNavigate } from "react-router-dom";
import { useAllSources } from "../api/useAllSources";
import { PrincipalCell } from "./PrincipalCell";
import { useAuth } from "@/lib/auth";
import { useState } from "react";
import "./styles.css";
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
}

export const GrantForm = ({ grant }: GrantFormProps) => {
  const navigate = useNavigate();
  const { can } = useAuth();
  const canReadSources = can("zeteo.sources.read");
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

  const chooseSource = (id: string) => {
    setSourceId(id);
    setTableId("");
    setChoice((c) => ({ ...c, selected: [] }));
  };
  const chooseTable = (id: string) => {
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

  const sourceOptions = sources.sources
    .filter((s) => !s.archived_at)
    .map((s) => ({ value: s.id, label: `${s.name} (${s.slug})` }));
  const tableOptions = tables.tables
    .filter((t) => !t.missing_since)
    .map((t) => ({ value: t.id, label: tableLabel(t) }));
  const selectsFailed = !canReadSources || sources.error?.status === 403;

  return (
    <div className="z-grant-form">
      <Form onSubmit={submit}>
        {grant ? (
          <>
            <div>
              <h2>Principal</h2>
              <PrincipalCell grant={grant} />
            </div>
            <div>
              <h2>Table</h2>
              <code>{grant.source.slug}</code>{" "}
              <span>{tableLabel(grant.table)}</span>
              {grant.table.missing && (
                <Alert variant="warning">
                  The last refresh no longer found this table. The grant is
                  kept.
                </Alert>
              )}
            </div>
          </>
        ) : (
          <>
            <div>
              <h2>Principal</h2>
              <PrincipalPicker value={principal} onChange={setPrincipal} />
            </div>
            <div>
              <h2>Table</h2>
              {selectsFailed ? (
                <Alert variant="warning">{NEEDS_SOURCES}</Alert>
              ) : (
                <>
                  <ErrorNotice error={sources.error} />
                  <Select
                    label="Source"
                    placeholder="Choose a source"
                    value={sourceId}
                    options={sourceOptions}
                    disabled={sources.isLoading}
                    onChange={(id) => chooseSource(id ?? "")}
                  />
                  <Select
                    label="Table"
                    placeholder="Choose a table"
                    value={tableId}
                    options={tableOptions}
                    disabled={!sourceId || tables.isLoading}
                    onChange={(id) => chooseTable(id ?? "")}
                  />
                  <ErrorNotice error={tables.error} />
                </>
              )}
            </div>
          </>
        )}

        {(grant || tableId) && (
          <>
            <ColumnChooser
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
          </>
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
        <FormActions>
          <Link to="/grants">Cancel</Link>
          <Button
            type="submit"
            fullWidth={false}
            isLoading={mutation.isPending}
            disabled={!canSubmit}
          >
            {grant ? "Save grant" : "Create grant"}
          </Button>
        </FormActions>
      </Form>
    </div>
  );
};
