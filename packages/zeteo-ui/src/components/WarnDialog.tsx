import { Alert, Button, Modal } from "@kosmeo-ui/react";

interface WarnDialogProps {
  title: string;
  warning: string;
  confirmLabel: string;
  onConfirm: () => void;
  onClose: () => void;
}

/** A warning that needs confirming before the change it is about goes ahead. */
export const WarnDialog = ({
  title,
  warning,
  confirmLabel,
  onConfirm,
  onClose,
}: WarnDialogProps) => (
  <Modal
    show
    title={title}
    onClose={onClose}
    footerButtons={[
      <Button
        key="cancel"
        variant="secondary"
        fullWidth={false}
        onClick={onClose}
      >
        Cancel
      </Button>,
      <Button key="confirm" fullWidth={false} onClick={onConfirm}>
        {confirmLabel}
      </Button>,
    ]}
  >
    <Alert variant="warning">{warning}</Alert>
  </Modal>
);
