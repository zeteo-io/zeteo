import { useUpdateColumn } from "../api/fileSources";
import { LoadFailure } from "./CastFailedNotice";
import { nameProblem } from "./PreviewEditor";
import { columnTypeName } from "./labels";
import { useState } from "react";
import {
  Alert,
  Button,
  Input,
  Modal,
  SearchSelect,
  TextArea,
} from "@kosmeo-ui/react";
import {
  FILE_COLUMN_TYPES,
  type FileColumnType,
  type FileSourceColumn,
  type UpdateColumn,
} from "../api/types";

export const RETYPE_WARNING =
  "Saved queries and dashboards that use this column may stop working with the new type.";

interface TypeChoice {
  id: FileColumnType;
  label: string;
}
const typeChoices: TypeChoice[] = FILE_COLUMN_TYPES.map((t) => ({
  id: t,
  label: columnTypeName(t),
}));

interface ColumnTypeDialogProps {
  sourceId: string;
  tableId: string;
  column: FileSourceColumn;
  onClose: () => void;
}

/**
 * A column's name, type and description. A new type reloads the table from
 * its stored values; a value that does not fit fails it with the rows, and
 * nothing changes.
 */
export const ColumnTypeDialog = ({
  sourceId,
  tableId,
  column,
  onClose,
}: ColumnTypeDialogProps) => {
  const update = useUpdateColumn(sourceId, tableId);
  const [name, setName] = useState(column.name);
  const [type, setType] = useState<FileColumnType>(column.type);
  const [description, setDescription] = useState(column.description ?? "");

  const body: UpdateColumn = {
    ...(name !== column.name && { name }),
    ...(type !== column.type && { type }),
    ...(description.trim() !== (column.description ?? "") && {
      description: description.trim() === "" ? null : description.trim(),
    }),
  };
  const changed = Object.keys(body).length > 0;
  const problem = nameProblem(name);
  const busy = update.isPending;

  return (
    <Modal
      show
      title={`Edit column ${column.name}`}
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
          key="save"
          fullWidth={false}
          isLoading={busy}
          disabled={busy || !changed || !!problem}
          onClick={() =>
            update.mutate({ columnId: column.id, body }, { onSuccess: onClose })
          }
        >
          Save column
        </Button>,
      ]}
    >
      <div className="z-fs-dialog">
        <Input
          label="Name"
          value={name}
          error={problem}
          onChange={(e) => setName(e.target.value)}
        />
        {column.original_name && column.original_name !== column.name && (
          <p className="z-note">From the header “{column.original_name}”.</p>
        )}
        <SearchSelect<TypeChoice>
          label="Type"
          value={typeChoices.find((t) => t.id === type) ?? null}
          options={typeChoices}
          getOptionLabel={(t) => t.label}
          getOptionKey={(t) => t.id}
          onSelect={(t) => setType(t.id)}
        />
        {type !== column.type && (
          <Alert variant="warning">
            {RETYPE_WARNING} The table is reloaded with the new type; if a value
            does not fit, nothing changes.
          </Alert>
        )}
        <TextArea
          label="Description"
          value={description}
          rows={3}
          onChange={(e) => setDescription(e.target.value)}
        />
        <LoadFailure error={update.error} rowsOf="table" />
      </div>
    </Modal>
  );
};
