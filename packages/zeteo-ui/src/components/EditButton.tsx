import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faPencil } from "@fortawesome/free-solid-svg-icons";
import { Button } from "@kosmeo-ui/react";

/** A row's Edit action, as a pencil. */
export const EditButton = ({ onClick }: { onClick: () => void }) => (
  <Button
    size="sm"
    variant="secondary"
    fullWidth={false}
    aria-label="Edit"
    title="Edit"
    onClick={onClick}
  >
    <FontAwesomeIcon icon={faPencil} />
  </Button>
);
