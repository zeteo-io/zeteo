import type { IconDefinition } from "@fortawesome/fontawesome-svg-core";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { Button } from "@kosmeo-ui/react";

interface IconActionProps {
  icon: IconDefinition;
  /** The accessible name and the tooltip. */
  label: string;
  onClick: () => void;
  expanded?: boolean;
}

/** An icon-only button, as in the admin tables' row actions. */
export const IconAction = ({
  icon,
  label,
  onClick,
  expanded,
}: IconActionProps) => (
  <Button
    size="sm"
    variant="secondary"
    fullWidth={false}
    aria-label={label}
    title={label}
    aria-expanded={expanded}
    onClick={onClick}
  >
    <FontAwesomeIcon icon={icon} />
  </Button>
);
