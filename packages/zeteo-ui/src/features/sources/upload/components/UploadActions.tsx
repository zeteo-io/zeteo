import type { SourceAccess } from "../../components/access";
import { sourceHref } from "../../components/sourceLabels";
import { ConfirmButton } from "@/components/ConfirmButton";
import { SourceForm } from "../../components/SourceForm";
import { useDeleteUploadSource } from "../api/uploads";
import { TransferDialog } from "./TransferDialog";
import { useNavigate } from "react-router-dom";
import type { Source } from "../../api/types";
import { Button } from "@kosmeo-ui/react";
import { MY_DATA_HREF } from "./labels";
import { useState } from "react";

/**
 * An upload's header actions (Add tables, Transfer, Edit, Delete) and the
 * dialogs they open: for its owner or a sources admin, until it is deleted.
 */
export const useUploadActions = (source: Source, access: SourceAccess) => {
  const navigate = useNavigate();
  const remove = useDeleteUploadSource();
  const [dialog, setDialog] = useState<"edit" | "transfer" | null>(null);
  const close = () => setDialog(null);

  const actions = access.canManage && (
    <div className="z-source-actions">
      <Button
        size="sm"
        variant="secondary"
        fullWidth={false}
        onClick={() => navigate(`${sourceHref(source.id)}/add`)}
      >
        Add tables
      </Button>
      <Button
        size="sm"
        variant="secondary"
        fullWidth={false}
        onClick={() => setDialog("transfer")}
      >
        Transfer
      </Button>
      <Button size="sm" fullWidth={false} onClick={() => setDialog("edit")}>
        Edit
      </Button>
      <span className="z-source-actions-gap" />
      <ConfirmButton
        label="Delete"
        size="sm"
        danger
        confirmTitle="Delete source"
        confirmText={`Delete "${source.name}" and all its data? Zeteo holds the only copy, so it cannot be recovered. Saved queries and dashboards using it stop working.`}
        confirmLabel="Delete source"
        onConfirm={async () => {
          await remove.mutateAsync(source.id);
          navigate(access.isOwner ? MY_DATA_HREF : "/sources");
        }}
      />
    </div>
  );

  const dialogs = (
    <>
      {dialog === "edit" && (
        <SourceForm
          source={source}
          title="Edit source"
          dialog={{ onDone: close }}
          upload={{ canSetLimits: access.canSetLimits }}
        />
      )}
      {dialog === "transfer" && (
        <TransferDialog
          source={source}
          onClose={close}
          onDone={() => access.isOwner && navigate(MY_DATA_HREF)}
        />
      )}
    </>
  );

  return { actions, dialogs };
};
