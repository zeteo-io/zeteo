import { NOUNS, type SharedObjectType } from "../api/sharedObjects";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { Alert, Button, Modal, Spinner } from "@kosmeo-ui/react";
import type { ReplaceSharesResult, Share } from "../api/types";
import { useReplaceShares } from "../api/useReplaceShares";
import type { Principal } from "@/features/principals";
import { ErrorNotice } from "@/components/ErrorNotice";
import { PeoplePicker } from "./PeoplePicker";
import { useShares } from "../api/useShares";
import { useEffect, useState } from "react";
import "./styles.css";
import {
  faUser,
  faUserGroup,
  faXmark,
} from "@fortawesome/free-solid-svg-icons";

interface ShareDialogProps {
  objectType: SharedObjectType;
  id: string;
  onClose: () => void;
}

const NOTES: Record<SharedObjectType, string> = {
  saved_query:
    "The name and description are visible to everyone it's shared with, including people who can't run it.",
  dashboard:
    "Everyone it's shared with can open it. Each panel shows only what their own access lets them run.",
  saved_panel:
    "Everyone it's shared with can see it and add it to their dashboards. It shows only what their own access lets them run.",
};

const labelOf = (s: { name: string | null; id: string }) => s.name ?? s.id;

/** Who a saved query, dashboard or saved panel is shared with: search, add, remove, then save the whole list. */
export const ShareDialog = ({ objectType, id, onClose }: ShareDialogProps) => {
  const current = useShares(objectType, id);
  const replace = useReplaceShares(objectType, id);
  const [list, setList] = useState<Share[] | null>(null);
  const [saved, setSaved] = useState<ReplaceSharesResult | null>(null);

  useEffect(() => {
    if (current.data && list === null) setList(current.data);
  }, [current.data, list]);

  const add = (p: Principal) =>
    setList((prev) => {
      const rows = prev ?? [];
      if (rows.some((r) => r.type === p.type && r.id === p.id)) return rows;
      return [
        ...rows,
        {
          type: p.type,
          id: p.id,
          name: p.name,
          email: p.email,
          shared_at: new Date().toISOString(),
        },
      ];
    });
  const remove = (s: Share) =>
    setList((prev) =>
      (prev ?? []).filter((r) => !(r.type === s.type && r.id === s.id))
    );

  const save = () =>
    replace.mutate(
      (list ?? []).map(({ type, id }) => ({ type, id })),
      {
        onSuccess: (result) => {
          if (!result.warnings?.length) onClose();
          else setSaved(result);
        },
      }
    );

  const busy = replace.isPending;

  if (saved) {
    return (
      <Modal
        show
        title="Sharing saved"
        onClose={onClose}
        footerButtons={[
          <Button key="done" fullWidth={false} onClick={onClose}>
            Done
          </Button>,
        ]}
      >
        <div className="z-share-form">
          {(saved.warnings ?? []).map((w) => {
            const who = saved.data.find((s) => s.id === w.id);
            const name = who ? labelOf(who) : w.id;
            return (
              <Alert key={w.id} variant="warning">
                {name} can't run this saved query until their access is
                expanded.
              </Alert>
            );
          })}
        </div>
      </Modal>
    );
  }

  return (
    <Modal
      show
      title={`Share ${NOUNS[objectType]}`}
      onClose={onClose}
      dismissible={!busy}
      footerButtons={[
        <Button
          key="cancel"
          variant="secondary"
          fullWidth={false}
          disabled={busy}
          onClick={onClose}
        >
          Cancel
        </Button>,
        <Button
          key="save"
          fullWidth={false}
          isLoading={busy}
          disabled={busy || list === null}
          onClick={save}
        >
          Save sharing
        </Button>,
      ]}
    >
      <div className="z-share-form">
        <PeoplePicker onPick={add} />
        {current.isLoading && <Spinner size="sm" />}
        <ErrorNotice error={current.error} />
        {list && list.length === 0 && (
          <p className="z-note">Not shared with anyone yet.</p>
        )}
        {list && list.length > 0 && (
          <ul className="z-share-list" aria-label="Shared with">
            {list.map((s) => (
              <li key={`${s.type}:${s.id}`} className="z-share-row">
                <FontAwesomeIcon
                  className="z-principal-icon"
                  icon={s.type === "group" ? faUserGroup : faUser}
                />
                <span>{labelOf(s)}</span>
                {s.email && (
                  <span className="z-principal-email">{s.email}</span>
                )}
                <Button
                  size="sm"
                  variant="danger"
                  fullWidth={false}
                  aria-label={`Remove ${labelOf(s)}`}
                  title="Remove"
                  onClick={() => remove(s)}
                >
                  <FontAwesomeIcon icon={faXmark} />
                </Button>
              </li>
            ))}
          </ul>
        )}
        <p className="z-note">{NOTES[objectType]}</p>
        <ErrorNotice error={replace.error} />
      </div>
    </Modal>
  );
};
