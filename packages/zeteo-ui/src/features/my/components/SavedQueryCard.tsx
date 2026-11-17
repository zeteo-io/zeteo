import { ConfirmButton } from "@/components/ConfirmButton";
import { formatRelative } from "@/utils/formatRelative";
import { NoAccessNotice } from "./NoAccessNotice";
import { formatDate } from "@/utils/formatDate";
import { Button, Card } from "@kosmeo-ui/react";
import { useState } from "react";
import {
  CopyDialog,
  EditDetailsDialog,
  ShareDialog,
  TransferDialog,
  ViewJsonDialog,
  useDeleteSavedQuery,
  type SavedQuery,
} from "@/features/saved-queries";

interface SavedQueryCardProps {
  savedQuery: SavedQuery;
  /** Mine: share, transfer, edit, delete. Shared: copy and view JSON. */
  kind: "mine" | "shared";
}

type Dialog = "share" | "transfer" | "edit" | "copy" | "json" | null;

const Time = ({ iso }: { iso: string }) => (
  <time dateTime={iso} title={formatDate(iso)}>
    {formatRelative(iso)}
  </time>
);

export const SavedQueryCard = ({
  savedQuery: sq,
  kind,
}: SavedQueryCardProps) => {
  const [dialog, setDialog] = useState<Dialog>(null);
  const remove = useDeleteSavedQuery();
  const close = () => setDialog(null);
  const lastRan = sq.you_last_ran_at ? (
    <>
      You last ran <Time iso={sq.you_last_ran_at} />
    </>
  ) : sq.last_run_at ? (
    <>
      Last run <Time iso={sq.last_run_at} />
    </>
  ) : (
    "Never run"
  );

  return (
    <div data-saved-query={sq.id}>
      <Card>
        <div className="z-sq-card">
          <div className="z-sq-head">
            <h3 className="z-sq-name">{sq.name}</h3>
            {sq.accessible && sq.source && (
              <span className="z-sq-source">{sq.source.slug}</span>
            )}
          </div>
          {sq.description && (
            <p className="z-sq-description">{sq.description}</p>
          )}
          <p className="z-muted">
            {kind === "shared" && (
              <>
                From {sq.owner.name ?? "someone"}
                {sq.shared_at && (
                  <>
                    {" "}
                    · shared <Time iso={sq.shared_at} />
                  </>
                )}{" "}
                ·{" "}
              </>
            )}
            {lastRan}
          </p>
          {!sq.accessible && <NoAccessNotice />}
          <div className="z-sq-actions">
            {kind === "mine" ? (
              <>
                <Button
                  size="sm"
                  variant="secondary"
                  fullWidth={false}
                  onClick={() => setDialog("share")}
                >
                  Share
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  fullWidth={false}
                  onClick={() => setDialog("transfer")}
                >
                  Transfer
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  fullWidth={false}
                  onClick={() => setDialog("edit")}
                >
                  Edit details
                </Button>
                {sq.accessible && (
                  <Button
                    size="sm"
                    variant="secondary"
                    fullWidth={false}
                    onClick={() => setDialog("json")}
                  >
                    View JSON
                  </Button>
                )}
                <ConfirmButton
                  label="Delete"
                  size="sm"
                  danger
                  confirmTitle="Delete saved query"
                  confirmText={`Delete "${sq.name}"? It stops being shared and cannot be recovered.`}
                  confirmLabel="Delete"
                  onConfirm={() => remove.mutateAsync(sq.id)}
                />
              </>
            ) : (
              sq.accessible && (
                <>
                  <Button
                    size="sm"
                    variant="secondary"
                    fullWidth={false}
                    onClick={() => setDialog("copy")}
                  >
                    Copy to mine
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    fullWidth={false}
                    onClick={() => setDialog("json")}
                  >
                    View JSON
                  </Button>
                </>
              )
            )}
          </div>
        </div>
      </Card>
      {dialog === "share" && (
        <ShareDialog savedQueryId={sq.id} onClose={close} />
      )}
      {dialog === "transfer" && (
        <TransferDialog savedQueryId={sq.id} onClose={close} />
      )}
      {dialog === "edit" && (
        <EditDetailsDialog savedQuery={sq} onClose={close} />
      )}
      {dialog === "copy" && <CopyDialog savedQuery={sq} onClose={close} />}
      {dialog === "json" && (
        <ViewJsonDialog title={sq.name} query={sq.query} onClose={close} />
      )}
    </div>
  );
};
