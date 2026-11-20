import { faTrash } from "@fortawesome/free-solid-svg-icons";
import { ConfirmButton } from "@/components/ConfirmButton";
import { useIdentityKeys } from "../api/useIdentityKeys";
import { ErrorNotice } from "@/components/ErrorNotice";
import { PrincipalCell } from "@/features/principals";
import { PageHeader } from "@/components/PageHeader";
import { BulkPasteDialog } from "./BulkPasteDialog";
import { Link, useParams } from "react-router-dom";
import type { IdentityValue } from "../api/types";
import { NotFound } from "@/components/NotFound";
import { useEffect, useState } from "react";
import { useAuth } from "@tereo-io/react";
import "./styles.css";
import {
  useDeleteIdentityValue,
  useIdentityValues,
  useMissingValues,
} from "../api/useIdentityValues";
import {
  Button,
  EmptyState,
  RowActions,
  Spinner,
  Switch,
  Table,
} from "@kosmeo-ui/react";

const DeleteValue = ({ keyId, row }: { keyId: string; row: IdentityValue }) => {
  const del = useDeleteIdentityValue(keyId);
  return (
    <ConfirmButton
      danger
      size="sm"
      icon={faTrash}
      label="Delete"
      confirmTitle="Delete this value?"
      confirmText="Rules using this key show this person nothing from now on, unless they hold another value."
      confirmLabel="Delete value"
      onConfirm={() => del.mutateAsync(row.id)}
    />
  );
};

export const IdentityValuesPage = () => {
  const { keyId = "" } = useParams();
  const { hasPermission } = useAuth();
  const canWrite = hasPermission("zeteo.grants.write");
  const keys = useIdentityKeys();
  const key = keys.keys.find((k) => k.id === keyId);
  const [missingOnly, setMissingOnly] = useState(false);
  const [adding, setAdding] = useState(false);
  const values = useIdentityValues(keyId, !missingOnly);
  const missing = useMissingValues(keyId, missingOnly);
  const [loadingMore, setLoadingMore] = useState(false);
  useEffect(
    () => setLoadingMore(false),
    [values.items.length, values.hasMore, values.error]
  );

  if (keys.isLoading) return <Spinner size="lg" />;
  if (!key) return <NotFound />;

  return (
    <>
      <PageHeader
        title={key.label}
        subtitle={<Link to="/identities">All identity keys</Link>}
        divider={false}
      />
      <div className="z-list-toolbar z-list-toolbar-top">
        <div className="z-list-toolbar-filters" />
        {canWrite && (
          <Button size="sm" fullWidth={false} onClick={() => setAdding(true)}>
            Add values
          </Button>
        )}
        <Switch
          size="sm"
          label="Missing"
          checked={missingOnly}
          onChange={(e) => setMissingOnly(e.target.checked)}
        />
      </div>
      {missingOnly ? (
        <>
          <ErrorNotice error={missing.error} />
          {missing.isLoading ? (
            <Spinner size="lg" />
          ) : (
            <Table
              rowKey={(row) => row.user_id}
              emptyMessage={
                missing.error ? undefined : (
                  <EmptyState>
                    Everyone granted a rule that uses this key has a value.
                  </EmptyState>
                )
              }
              columns={[
                {
                  title: "Person with no value",
                  cellElement: (row) => (
                    <PrincipalCell
                      principal_type="user"
                      principal_id={row.user_id}
                      status="active"
                    />
                  ),
                },
              ]}
              rows={missing.data ?? []}
            />
          )}
        </>
      ) : (
        <>
          <ErrorNotice error={values.error} />
          {values.isLoading ? (
            <Spinner size="lg" />
          ) : (
            <div className={canWrite ? "z-actions-last" : undefined}>
              <Table<IdentityValue>
                rowKey={(row) => row.id}
                emptyMessage={
                  values.error ? undefined : (
                    <EmptyState>
                      No values yet. Add values to give people something for
                      rules to match.
                    </EmptyState>
                  )
                }
                columns={[
                  {
                    title: "Person",
                    cellElement: (row) => (
                      <PrincipalCell
                        principal_type="user"
                        principal_id={row.user_id}
                        status="active"
                      />
                    ),
                  },
                  { title: "Value", cellElement: (row) => row.value },
                  ...(canWrite
                    ? [
                        {
                          title: "",
                          cellElement: (row: IdentityValue) => (
                            <RowActions align="end">
                              <DeleteValue keyId={keyId} row={row} />
                            </RowActions>
                          ),
                        },
                      ]
                    : []),
                ]}
                rows={values.items}
              />
            </div>
          )}
          {values.hasMore && (
            <div className="z-identity-more">
              <Button
                variant="secondary"
                fullWidth={false}
                isLoading={loadingMore}
                disabled={loadingMore}
                onClick={() => {
                  setLoadingMore(true);
                  values.loadMore();
                }}
              >
                Load more
              </Button>
            </div>
          )}
        </>
      )}
      {canWrite && adding && (
        <BulkPasteDialog
          keyId={keyId}
          keyLabel={key.label}
          onClose={() => setAdding(false)}
        />
      )}
    </>
  );
};
