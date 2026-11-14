import { Button, ConfirmationModal } from "@kosmeo-ui/react";
import { useState } from "react";

interface ConfirmButtonProps {
  label: string;
  confirmTitle: string;
  confirmText: string;
  confirmLabel: string;
  /** May return a promise: the modal stays open and busy until it settles. */
  onConfirm: () => void | Promise<unknown>;
  danger?: boolean;
}

export const ConfirmButton = ({
  label,
  confirmTitle,
  confirmText,
  confirmLabel,
  onConfirm,
  danger = false,
}: ConfirmButtonProps) => {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const confirm = async () => {
    setBusy(true);
    try {
      await onConfirm();
    } finally {
      setBusy(false);
      setOpen(false);
    }
  };

  return (
    <>
      <Button
        variant={danger ? "danger" : "secondary"}
        fullWidth={false}
        onClick={() => setOpen(true)}
      >
        {label}
      </Button>
      <ConfirmationModal
        show={open}
        title={confirmTitle}
        body={confirmText}
        confirmButtonText={confirmLabel}
        isLoading={busy}
        dismissible={!busy}
        handleHide={() => setOpen(false)}
        handleConfirm={() => void confirm()}
      />
    </>
  );
};
