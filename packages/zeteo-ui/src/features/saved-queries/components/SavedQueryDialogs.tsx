import "./styles.css";
import { Alert, Button, Input, Modal, TextArea } from "@kosmeo-ui/react";
import { useUpdateSavedQuery } from "../api/useUpdateSavedQuery";
import { useCreateSavedQuery } from "../api/useCreateSavedQuery";
import { useCopySavedQuery } from "../api/useCopySavedQuery";
import { ErrorNotice } from "@/components/ErrorNotice";
import { useState, type ReactNode } from "react";
import type { SavedQuery } from "../api/types";
import type { ApiError } from "@/lib/api";

const NAME_CONFLICT = "You already have a saved query with this name.";

interface FormModalProps {
  title: string;
  submitLabel: string;
  busy: boolean;
  disabled?: boolean;
  onSubmit: () => void;
  onClose: () => void;
  children: ReactNode;
}

const FormModal = ({
  title,
  submitLabel,
  busy,
  disabled,
  onSubmit,
  onClose,
  children,
}: FormModalProps) => (
  <Modal
    show
    title={title}
    onClose={onClose}
    dismissible={!busy}
    footerButtons={[
      <Button
        key="cancel"
        variant="secondary"
        fullWidth={false}
        disabled={busy}
        onClick={onClose}
      >
        Cancel
      </Button>,
      <Button
        key="submit"
        fullWidth={false}
        isLoading={busy}
        disabled={busy || disabled}
        onClick={onSubmit}
      >
        {submitLabel}
      </Button>,
    ]}
  >
    <div className="z-my-form">{children}</div>
  </Modal>
);

const Failure = ({ error }: { error: ApiError | null }) =>
  error?.status === 409 ? (
    <Alert variant="warning">{NAME_CONFLICT}</Alert>
  ) : (
    <ErrorNotice error={error} />
  );

/** Name and description only: the query's JSON is changed through the API or MCP. */
export const EditDetailsDialog = ({
  savedQuery,
  onClose,
}: {
  savedQuery: SavedQuery;
  onClose: () => void;
}) => {
  const update = useUpdateSavedQuery();
  const [name, setName] = useState(savedQuery.name);
  const [description, setDescription] = useState(savedQuery.description);
  const trimmed = name.trim();
  const unchanged =
    trimmed === savedQuery.name && description === savedQuery.description;

  const submit = () =>
    update.mutate(
      {
        id: savedQuery.id,
        body: {
          ...(trimmed !== savedQuery.name ? { name: trimmed } : {}),
          ...(description !== savedQuery.description ? { description } : {}),
        },
      },
      { onSuccess: onClose }
    );

  return (
    <FormModal
      title="Edit details"
      submitLabel="Save"
      busy={update.isPending}
      disabled={unchanged || trimmed === ""}
      onSubmit={submit}
      onClose={onClose}
    >
      <Input
        label="Name"
        value={name}
        max={100}
        onChange={(e) => setName(e.target.value)}
      />
      <TextArea
        label="Description"
        value={description}
        max={2000}
        onChange={(e) => setDescription(e.target.value)}
      />
      <Failure error={update.error} />
    </FormModal>
  );
};

/** Copies a saved query shared with the person into their own. */
export const CopyDialog = ({
  savedQuery,
  onClose,
}: {
  savedQuery: SavedQuery;
  onClose: () => void;
}) => {
  const copy = useCopySavedQuery();
  const [name, setName] = useState(`${savedQuery.name} (copy)`);
  const trimmed = name.trim();
  return (
    <FormModal
      title="Copy to my saved queries"
      submitLabel="Copy"
      busy={copy.isPending}
      disabled={trimmed === ""}
      onSubmit={() =>
        copy.mutate(
          { id: savedQuery.id, name: trimmed },
          { onSuccess: onClose }
        )
      }
      onClose={onClose}
    >
      <Input
        label="Name"
        value={name}
        max={100}
        onChange={(e) => setName(e.target.value)}
      />
      <Failure error={copy.error} />
    </FormModal>
  );
};

/** Create: empty, or pre-filled with the JSON of a run. */
export const SaveQueryDialog = ({
  query,
  onClose,
}: {
  query?: unknown;
  onClose: () => void;
}) => {
  const create = useCreateSavedQuery();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [json, setJson] = useState(
    query === undefined ? "" : JSON.stringify(query, null, 2)
  );
  const [problem, setProblem] = useState<string | null>(null);

  const submit = () => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      setProblem("The query is not valid JSON.");
      return;
    }
    setProblem(null);
    create.mutate(
      { name: name.trim(), description, query: parsed },
      { onSuccess: onClose }
    );
  };

  return (
    <FormModal
      title="Save as saved query"
      submitLabel="Save saved query"
      busy={create.isPending}
      disabled={name.trim() === "" || json.trim() === ""}
      onSubmit={submit}
      onClose={onClose}
    >
      <Input
        label="Name"
        value={name}
        max={100}
        onChange={(e) => setName(e.target.value)}
      />
      <TextArea
        label="Description"
        value={description}
        max={2000}
        onChange={(e) => setDescription(e.target.value)}
      />
      <TextArea
        label="Query (JSON)"
        value={json}
        rows={10}
        onChange={(e) => setJson(e.target.value)}
      />
      {problem && <Alert variant="warning">{problem}</Alert>}
      <Failure error={create.error} />
    </FormModal>
  );
};

/** A query's JSON, read only. */
export const ViewJsonDialog = ({
  title,
  query,
  onClose,
}: {
  title: string;
  query: unknown;
  onClose: () => void;
}) => (
  <Modal
    show
    title={title}
    onClose={onClose}
    footerButtons={[
      <Button key="close" fullWidth={false} onClick={onClose}>
        Close
      </Button>,
    ]}
  >
    <pre className="z-my-json">{JSON.stringify(query, null, 2)}</pre>
  </Modal>
);
