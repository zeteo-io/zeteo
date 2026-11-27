import { useCreateIdentityKey } from "../api/useCreateIdentityKey";
import { useIdentityKeys } from "../api/useIdentityKeys";
import { ErrorNotice } from "@/components/ErrorNotice";
import { PageHeader } from "@/components/PageHeader";
import type { IdentityKey } from "../api/types";
import { useAuth } from "@tereo-io/react";
import type { ApiError } from "@/lib/api";
import { Link } from "react-router-dom";
import { useState } from "react";
import "./styles.css";
import {
  Alert,
  Badge,
  Button,
  EmptyState,
  Input,
  Modal,
  Spinner,
  Table,
} from "@kosmeo-ui/react";

const NAME = /^[a-z][a-z0-9_]{0,63}$/;

const NewKeyDialog = ({ onClose }: { onClose: () => void }) => {
  const create = useCreateIdentityKey();
  const [name, setName] = useState("");
  const [label, setLabel] = useState("");
  const [description, setDescription] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [failure, setFailure] = useState<ApiError | null>(null);

  const submit = () => {
    setFailure(null);
    if (!NAME.test(name)) {
      return setProblem(
        "A name is a lowercase letter, then up to 63 of a-z, 0-9 and _."
      );
    }
    if (!label.trim()) return setProblem("Give the key a label.");
    setProblem(null);
    create.mutate(
      {
        name,
        label: label.trim(),
        ...(description.trim() && { description: description.trim() }),
      },
      { onSuccess: onClose, onError: setFailure }
    );
  };

  return (
    <Modal
      show
      title="New identity key"
      onClose={onClose}
      dismissible={!create.isPending}
      footerButtons={[
        <Button
          key="cancel"
          variant="secondary"
          fullWidth={false}
          disabled={create.isPending}
          onClick={onClose}
        >
          Cancel
        </Button>,
        <Button
          key="create"
          fullWidth={false}
          isLoading={create.isPending}
          disabled={create.isPending}
          onClick={submit}
        >
          Create key
        </Button>,
      ]}
    >
      <div className="z-identity-form">
        <Input
          label="Label"
          helperText='How rules read it: "is one of my <label>", for example "regions".'
          value={label}
          onChange={(e) => setLabel(e.target.value)}
        />
        <Input
          label="Name"
          helperText="What a rule names. It cannot be changed later."
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <Input
          label="Description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
        {problem && <Alert variant="warning">{problem}</Alert>}
        <ErrorNotice error={failure} />
      </div>
    </Modal>
  );
};

export const IdentityKeysPage = () => {
  const { hasPermission } = useAuth();
  const { keys, isLoading, error } = useIdentityKeys();
  const [creating, setCreating] = useState(false);
  const canWrite = hasPermission("zeteo.grants.write");

  return (
    <>
      <PageHeader
        title="Identities"
        divider={false}
        actions={
          canWrite && (
            <Button
              size="sm"
              fullWidth={false}
              onClick={() => setCreating(true)}
            >
              New key
            </Button>
          )
        }
      />
      <ErrorNotice error={error} />
      {isLoading ? (
        <Spinner size="lg" />
      ) : (
        <Table<IdentityKey>
          rowKey={(key) => key.id ?? key.name}
          emptyMessage={
            error ? undefined : (
              <EmptyState>
                No identity keys yet. A key maps each person to the values a row
                rule can compare a column with, such as their regions.
              </EmptyState>
            )
          }
          columns={[
            {
              title: "Key",
              cellElement: (key) => (
                <>
                  <Link className="z-plain-link" to={`/identities/${key.id}`}>
                    {key.label}
                  </Link>{" "}
                  <Badge variant="secondary" size="sm">
                    {key.name}
                  </Badge>
                </>
              ),
            },
            {
              title: "Description",
              cellElement: (key) =>
                key.description ?? <span className="z-muted">—</span>,
            },
            {
              title: "People with a value",
              cellElement: (key) => key.value_count ?? 0,
            },
          ]}
          rows={keys}
        />
      )}
      {creating && <NewKeyDialog onClose={() => setCreating(false)} />}
    </>
  );
};
