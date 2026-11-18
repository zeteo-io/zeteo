import { useRenameRelation } from "../api/useRenameRelation";
import { Button, Input, Modal } from "@kosmeo-ui/react";
import { ErrorNotice } from "@/components/ErrorNotice";
import { nameProblem } from "@/utils/queryName";
import type { Relation } from "../api/types";
import { useState } from "react";

/** Renames a declared relation; queries join through it by name. */
export const RenameRelationDialog = ({
  sourceId,
  relation,
  onClose,
}: {
  sourceId: string;
  relation: Relation;
  onClose: () => void;
}) => {
  const rename = useRenameRelation(sourceId);
  const [name, setName] = useState(relation.name);
  const problem = nameProblem(name);
  return (
    <Modal
      show
      title="Rename relation"
      onClose={onClose}
      dismissible={!rename.isPending}
      footerButtons={[
        <Button
          key="cancel"
          variant="secondary"
          fullWidth={false}
          disabled={rename.isPending}
          onClick={onClose}
        >
          Cancel
        </Button>,
        <Button
          key="rename"
          fullWidth={false}
          isLoading={rename.isPending}
          disabled={rename.isPending || !!problem || name === relation.name}
          onClick={() =>
            rename.mutate({ id: relation.id, name }, { onSuccess: onClose })
          }
        >
          Rename
        </Button>,
      ]}
    >
      <div className="z-dialog-stack">
        <Input
          label="Name"
          value={name}
          error={problem}
          onChange={(e) => setName(e.target.value)}
        />
        <p className="z-note">
          Queries join through a relation by its name, so saved queries using
          the old name stop working.
        </p>
        <ErrorNotice error={rename.error} />
      </div>
    </Modal>
  );
};
