import { PeoplePicker } from "@/features/saved-queries/components/PeoplePicker";
import { useRenameFileSource, useTransferFileSource } from "../api/fileSources";
import { Button, Checkbox, Input, Modal } from "@kosmeo-ui/react";
import { ErrorNotice } from "@/components/ErrorNotice";
import type { Principal } from "@/features/principals";
import type { FileSource } from "../api/types";
import { useState } from "react";

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
