import type { IconDefinition } from "@fortawesome/fontawesome-svg-core";
import { ConfirmButton } from "@/components/ConfirmButton";
import { usePrincipalNames } from "@/features/principals";
import { useDeleteGrant } from "../api/useDeleteGrant";
import { tableLabel } from "@/features/tables";
import type { Grant } from "../api/types";

interface GrantDeleteButtonProps {
  grant: Grant;
  label: string;
  confirmLabel: string;
  /** Runs once the grant is removed. */
  onDeleted?: () => void;
  size?: "sm" | "md" | "lg";
  icon?: IconDefinition;
}

/** Deletes a grant after a confirmation that names whose grant on which table goes. */
export const GrantDeleteButton = ({
  grant,
  label,
  confirmLabel,
  onDeleted,
  size,
  icon,
}: GrantDeleteButtonProps) => {
  const del = useDeleteGrant();
  const ref = { type: grant.principal_type, id: grant.principal_id };
  const principal = usePrincipalNames([ref]).get(ref);
  const who = principal?.name ?? `${ref.type} ${ref.id}`;
  return (
    <ConfirmButton
      danger
      size={size}
      icon={icon}
      label={label}
      confirmTitle="Delete this grant?"
      confirmText={`Remove ${who}'s grant on ${grant.source.slug} · ${tableLabel(grant.table)}? They will no longer be able to query this table through this grant.`}
      confirmLabel={confirmLabel}
      onConfirm={() =>
        del.mutateAsync(grant.id).then(() => {
          onDeleted?.();
        })
      }
    />
  );
};
