import type { IconDefinition } from "@fortawesome/fontawesome-svg-core";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { toApiError, type ApiError } from "@/lib/api";
import { Button, Modal } from "@kosmeo-ui/react";
import { ErrorNotice } from "./ErrorNotice";
import { useState } from "react";

interface ConfirmButtonProps {
  label: string;
  confirmTitle: string;
  confirmText: string;
  confirmLabel: string;
  /** May return a promise: the modal stays open and busy until it settles. */
  onConfirm: () => void | Promise<unknown>;
  danger?: boolean;
  size?: "sm" | "md" | "lg";
  /** Shows only this icon; `label` becomes its accessible name and tooltip. */
  icon?: IconDefinition;
}

export const ConfirmButton = ({
  label,
  confirmTitle,
  confirmText,
  confirmLabel,
  onConfirm,
  danger = false,
  size,
  icon,
}: ConfirmButtonProps) => {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  const close = () => {
    setOpen(false);
    setError(null);
  };

  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      await onConfirm();
      setBusy(false);
      close();
    } catch (err) {
      // Stay open so the failure is read where the action was asked for.
      setBusy(false);
      setError(toApiError(err));
    }
  };

  return (
    <>
      <Button
        variant={danger ? "danger" : "secondary"}
        size={size}
        fullWidth={false}
        aria-label={icon ? label : undefined}
        title={icon ? label : undefined}
        onClick={() => setOpen(true)}
      >
        {icon ? <FontAwesomeIcon icon={icon} /> : label}
      </Button>
      <Modal
        show={open}
        title={confirmTitle}
        onClose={close}
        dismissible={!busy}
        footerButtons={[
          <Button
            key="cancel"
            variant="secondary"
            fullWidth={false}
            disabled={busy}
            onClick={close}
          >
            Cancel
          </Button>,
          <Button
            key="confirm"
            variant={danger ? "danger" : "primary"}
            fullWidth={false}
            isLoading={busy}
            disabled={busy}
            onClick={() => void confirm()}
          >
            {confirmLabel}
          </Button>,
        ]}
      >
        <p>{confirmText}</p>
        <ErrorNotice error={error} />
      </Modal>
    </>
  );
};
