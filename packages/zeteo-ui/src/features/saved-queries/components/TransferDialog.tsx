import { Alert, Button, Checkbox, Modal } from "@kosmeo-ui/react";
import type { Principal } from "@/features/principals";
import { ErrorNotice } from "@/components/ErrorNotice";
import { useTransfer } from "../api/useTransfer";
import { PeoplePicker } from "./PeoplePicker";
import { useState } from "react";
import "./styles.css";

interface TransferDialogProps {
  savedQueryId: string;
  onClose: () => void;
}

/** Hands a saved query to another person; the sender can keep access to it. */
export const TransferDialog = ({
  savedQueryId,
  onClose,
}: TransferDialogProps) => {
  const transfer = useTransfer(savedQueryId);
  const [person, setPerson] = useState<Principal | null>(null);
  const [keepAccess, setKeepAccess] = useState(true);
  const [warned, setWarned] = useState(false);
  const name = person?.name ?? person?.id ?? "";

  const submit = () =>
    person &&
    transfer.mutate(
      { user_id: person.id, keep_access: keepAccess },
      {
        onSuccess: (result) => {
          if (result.warning) setWarned(true);
          else onClose();
        },
      }
    );

  const busy = transfer.isPending;
  const conflict = transfer.error?.status === 409;

  if (warned) {
    return (
      <Modal
        show
        title="Saved query transferred"
        onClose={onClose}
        footerButtons={[
          <Button key="done" fullWidth={false} onClick={onClose}>
            Done
          </Button>,
        ]}
      >
        <Alert variant="warning">
          {name} can't run this saved query until their access is expanded.
        </Alert>
      </Modal>
    );
  }

  return (
    <Modal
      show
      title="Transfer saved query"
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
          key="transfer"
          fullWidth={false}
          isLoading={busy}
          disabled={busy || !person}
          onClick={submit}
        >
          Transfer
        </Button>,
      ]}
    >
      <div className="z-share-form">
        <PeoplePicker types={["user"]} onPick={setPerson} />
        {person && (
          <p>
            New owner: <strong>{name}</strong>
          </p>
        )}
        <Checkbox
          label="Keep my access"
          labelLocation="right"
          checked={keepAccess}
          onChange={(e) => setKeepAccess(e.target.checked)}
        />
        <p className="z-muted">
          {keepAccess
            ? "It is shared with you afterwards, so you can still run it."
            : "You lose access to it unless the new owner shares it back."}
        </p>
        {conflict ? (
          <Alert variant="warning">
            {name} already has a saved query with this name. Rename this one,
            then transfer it.
          </Alert>
        ) : (
          <ErrorNotice error={transfer.error} />
        )}
      </div>
    </Modal>
  );
};
