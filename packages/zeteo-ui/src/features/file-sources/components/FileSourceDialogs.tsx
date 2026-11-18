import { PeoplePicker } from "@/features/saved-queries/components/PeoplePicker";
import { Button, Checkbox, Input, Modal, TextArea } from "@kosmeo-ui/react";
import { ErrorNotice } from "@/components/ErrorNotice";
import type { Principal } from "@/features/principals";
import type { FileSourceTable } from "../api/types";
import type { FileSource } from "../api/types";
import { useState } from "react";
import {
  useDescribeTable,
  useRenameFileSource,
  useTransferFileSource,
} from "../api/fileSources";

interface DialogProps {
  source: FileSource;
  onClose: () => void;
  /** Runs once the change is made. */
  onDone?: () => void;
}

const footer = (
  busy: boolean,
  disabled: boolean,
  label: string,
  onClose: () => void,
  onSubmit: () => void
) => [
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
    {label}
  </Button>,
];

export const RenameDialog = ({ source, onClose }: DialogProps) => {
  const rename = useRenameFileSource(source.id);
  const [name, setName] = useState(source.name);
  const trimmed = name.trim();
  return (
    <Modal
      show
      title="Rename source"
      onClose={onClose}
      dismissible={!rename.isPending}
      footerButtons={footer(
        rename.isPending,
        trimmed === "" || trimmed === source.name,
        "Rename",
        onClose,
        () => rename.mutate(trimmed, { onSuccess: onClose })
      )}
    >
      <div className="z-fs-dialog">
        <Input
          label="Name"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <p className="z-note">
          The slug <code>{source.slug}</code> stays, so queries keep working.
        </p>
        <ErrorNotice error={rename.error} />
      </div>
    </Modal>
  );
};

/** Hands the source to another user, who becomes its owner; the sender keeps access unless told not to. */
export const TransferDialog = ({ source, onClose, onDone }: DialogProps) => {
  const transfer = useTransferFileSource(source.id);
  const [person, setPerson] = useState<Principal | null>(null);
  const [keepAccess, setKeepAccess] = useState(true);
  return (
    <Modal
      show
      title="Transfer source"
      onClose={onClose}
      dismissible={!transfer.isPending}
      footerButtons={footer(
        transfer.isPending,
        !person,
        "Transfer",
        onClose,
        () =>
          person &&
          transfer.mutate(
            { user_id: person.id, keep_access: keepAccess },
            {
              onSuccess: () => {
                onClose();
                onDone?.();
              },
            }
          )
      )}
    >
      <div className="z-fs-dialog">
        <PeoplePicker types={["user"]} onPick={setPerson} />
        {person && (
          <p>
            New owner: <strong>{person.name ?? person.id}</strong>
          </p>
        )}
        <Checkbox
          label="The previous owner keeps access"
          labelLocation="right"
          checked={keepAccess}
          onChange={(e) => setKeepAccess(e.target.checked)}
        />
        <p className="z-note">
          {keepAccess
            ? "The previous owner can still query every table afterwards."
            : "The previous owner's access to its tables is removed."}{" "}
          The new owner manages its data and who it is shared with, and it
          counts towards their storage.
        </p>
        <ErrorNotice error={transfer.error} />
      </div>
    </Modal>
  );
};

/** A table's description; emptied, it is cleared. */
export const TableDescriptionDialog = ({
  source,
  table,
  onClose,
}: {
  source: FileSource;
  table: FileSourceTable;
  onClose: () => void;
}) => {
  const describe = useDescribeTable(source.id, table.id);
  const [text, setText] = useState(table.description ?? "");
  const next = text.trim() === "" ? null : text.trim();
  return (
    <Modal
      show
      title={`Describe ${table.name}`}
      onClose={onClose}
      dismissible={!describe.isPending}
      footerButtons={footer(
        describe.isPending,
        next === table.description,
        "Save description",
        onClose,
        () => describe.mutate(next, { onSuccess: onClose })
      )}
    >
      <div className="z-fs-dialog">
        <TextArea
          label="Description"
          value={text}
          rows={4}
          onChange={(e) => setText(e.target.value)}
        />
        <p className="z-note">
          People it is shared with see it, and so does an AI assistant choosing
          what to query.
        </p>
        <ErrorNotice error={describe.error} />
      </div>
    </Modal>
  );
};
