import { ConfirmButton } from "@/components/ConfirmButton";
import { formatRelative } from "@/utils/formatRelative";
import { NoAccessNotice } from "./NoAccessNotice";
import { formatDate } from "@/utils/formatDate";
import { IconAction } from "./IconAction";
import { savedQueryHref } from "./tabs";
import { Card } from "@kosmeo-ui/react";
import { Link } from "react-router-dom";
import { useState } from "react";
import {
  faCode,
  faCopy,
  faPen,
  faRightLeft,
  faShareNodes,
  faTrash,
} from "@fortawesome/free-solid-svg-icons";
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
      You ran it <Time iso={sq.you_last_ran_at} />
    </>
  ) : sq.last_run_at ? (
    <>
      Last run <Time iso={sq.last_run_at} />
    </>
  ) : (
    "Never run"
  );

  return (
    <div data-saved-query={sq.id} className="z-sq-card-wrap">
      <Card>
        <div className="z-sq-card">
          <div className="z-sq-head">
            <h3 className="z-sq-title">
              <Link to={savedQueryHref(sq.id)}>{sq.name}</Link>
            </h3>
            {sq.accessible && sq.source && (
              <code className="z-sq-source">{sq.source.slug}</code>
            )}
          </div>
          {sq.description ? (
            <p className="z-sq-description">{sq.description}</p>
          ) : (
            <p className="z-note">No description.</p>
          )}
          {!sq.accessible && <NoAccessNotice />}
          <div className="z-sq-foot">
            <p className="z-note">
              {kind === "shared" && <>From {sq.owner.name ?? "someone"} · </>}
              {lastRan}
            </p>
            <div className="z-sq-actions">
              {kind === "mine" ? (
                <>
                  <IconAction
                    icon={faShareNodes}
                    label="Share"
                    onClick={() => setDialog("share")}
                  />
                  <IconAction
                    icon={faRightLeft}
                    label="Transfer"
                    onClick={() => setDialog("transfer")}
                  />
                  <IconAction
                    icon={faPen}
                    label="Edit details"
                    onClick={() => setDialog("edit")}
                  />
                  {sq.accessible && (
                    <IconAction
                      icon={faCode}
                      label="View JSON"
                      onClick={() => setDialog("json")}
                    />
                  )}
                  <ConfirmButton
                    label="Delete"
                    icon={faTrash}
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
                    <IconAction
                      icon={faCopy}
                      label="Copy to mine"
                      onClick={() => setDialog("copy")}
                    />
                    <IconAction
                      icon={faCode}
                      label="View JSON"
                      onClick={() => setDialog("json")}
                    />
                  </>
                )
              )}
            </div>
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
