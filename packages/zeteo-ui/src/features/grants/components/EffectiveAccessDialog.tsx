import { Alert, Button, Modal, Spinner } from "@kosmeo-ui/react";
import { tableLabel, useAllTables } from "@/features/tables";
import { ErrorNotice } from "@/components/ErrorNotice";
import { useIdentityKeys } from "@/features/identity";
import type { Grant } from "../api/types";
import { useState } from "react";
import "./styles.css";
import {
  useEffectiveAccess,
  type EffectiveWarning,
} from "../api/useEffectiveAccess";
import {
  PrincipalCell,
  PrincipalPicker,
  usePrincipalNames,
  type PrincipalRef,
} from "@/features/principals";

const ROWS = {
  all: "Every row",
  limited: "Only some rows",
  none: "No rows",
} as const;

const Warning = ({
  warning,
  grants,
  sourceId,
}: {
  warning: EffectiveWarning;
  grants: {
    grant_id: string;
    principal_type: "user" | "group";
    principal_id: string;
  }[];
  sourceId: string;
}) => {
  const keys = useIdentityKeys(warning.code === "missing_identity_value");
  const tables = useAllTables(
    warning.code === "merged_members_limited" ? sourceId : undefined
  );
  const grant =
    warning.code === "all_rows_overrides"
      ? grants.find((g) => g.grant_id === warning.grant_id)
      : undefined;
  const ref: PrincipalRef[] = grant
    ? [{ type: grant.principal_type, id: grant.principal_id }]
    : [];
  const { get } = usePrincipalNames(ref);

  switch (warning.code) {
    case "all_rows_overrides": {
      const who = grant
        ? (get(ref[0])?.name ?? grant.principal_id)
        : "another principal";
      return `The grant to ${who} is All rows, so this user sees every row.`;
    }
    case "missing_identity_value": {
      const label =
        keys.keys.find((k) => k.name === warning.key)?.label ?? warning.key;
      return `This user has no ${label}, so rules using it show them nothing.`;
    }
    case "merged_members_limited": {
      const members = warning.member_table_ids
        .map((id) => tables.labelFor(id))
        .join(", ");
      return `This user's access to ${members} is limited differently from this merged table.`;
    }
    case "row_rule_unavailable":
      switch (warning.reason) {
        case "too_many_values":
          return "This user's rule resolves to too many values (or too many people report to them); queries on this table are refused.";
        case "hierarchy_unavailable":
          return "Reporting lines couldn't be read from Tereo; queries using them are refused until it answers.";
        default:
          return "A rule names a column that no longer exists; queries on this table are refused.";
      }
  }
};

/** What one person gets of the grant's table: columns, rows, the contributing grants and what to watch for. */
export const EffectiveAccessDialog = ({
  grant,
  onClose,
}: {
  grant: Grant;
  onClose: () => void;
}) => {
  const [person, setPerson] = useState<PrincipalRef | null>(
    grant.principal_type === "user"
      ? { type: "user", id: grant.principal_id }
      : null
  );
  const access = useEffectiveAccess(person?.id, grant.table.id);
  const data = access.data;

  return (
    <Modal
      show
      title={`Effective access to ${tableLabel(grant.table)}`}
      onClose={onClose}
      footerButtons={[
        <Button
          key="close"
          variant="secondary"
          fullWidth={false}
          onClick={onClose}
        >
          Close
        </Button>,
      ]}
    >
      <div className="z-effective">
        <PrincipalPicker
          value={person}
          types={["user"]}
          onChange={(p) => setPerson(p)}
        />
        {person && access.isLoading && <Spinner size="sm" />}
        <ErrorNotice error={access.error} />
        {data && (
          <>
            <dl className="z-effective-facts">
              <dt>Columns</dt>
              <dd>
                {data.columns === "all"
                  ? "All columns"
                  : data.columns.length === 0
                    ? "None"
                    : data.columns.join(", ")}
              </dd>
              <dt>Rows</dt>
              <dd>
                {ROWS[data.rows]}
                {data.rule_summary && (
                  <span className="z-muted"> — {data.rule_summary}</span>
                )}
              </dd>
            </dl>
            <div>
              <h4>Grants that apply</h4>
              {data.grants.length === 0 ? (
                <p className="z-muted">No grant gives this person the table.</p>
              ) : (
                <ul className="z-effective-grants">
                  {data.grants.map((g) => (
                    <li key={g.grant_id}>
                      <PrincipalCell
                        principal_type={g.principal_type}
                        principal_id={g.principal_id}
                        status="active"
                      />{" "}
                      <span className="z-muted">
                        {g.row_access === "all"
                          ? "All rows"
                          : g.row_access === "rule"
                            ? "Row rule"
                            : "No row limit set"}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            {data.warnings.map((w, i) => (
              <Alert key={i} variant="warning">
                <Warning
                  warning={w}
                  grants={data.grants}
                  sourceId={grant.source.id}
                />
              </Alert>
            ))}
          </>
        )}
      </div>
    </Modal>
  );
};
