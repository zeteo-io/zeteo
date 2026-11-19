import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faTrash } from "@fortawesome/free-solid-svg-icons";
import { Button, Modal, Spinner } from "@kosmeo-ui/react";
import { ErrorNotice } from "@/components/ErrorNotice";
import { useMemo, useState } from "react";
import "./styles.css";
import {
  useMeasureEditors,
  useReplaceMeasureEditors,
} from "../api/useMeasureEditors";
import {
  PrincipalLabel,
  PrincipalPicker,
  type PrincipalRef,
} from "@/features/principals";

const same = (a: PrincipalRef, b: PrincipalRef) =>
  a.type === b.type && a.id === b.id;

/** Who may manage a source's measures, besides `zeteo.measures.write` admins: users and groups, replaced as a whole. */
export const MeasureEditorsDialog = ({
  sourceId,
  onClose,
}: {
  sourceId: string;
  onClose: () => void;
}) => {
  const current = useMeasureEditors(sourceId);
  const replace = useReplaceMeasureEditors(sourceId);
  const [edited, setEdited] = useState<PrincipalRef[] | null>(null);
  const loaded = useMemo<PrincipalRef[]>(
    () => (current.data ?? []).map(({ type, id }) => ({ type, id })),
    [current.data]
  );
  const editors = edited ?? loaded;
  const names = new Map(
    (current.data ?? []).map((e) => [`${e.type}:${e.id}`, e.name])
  );

  return (
    <Modal
      show
      title="Measure editors"
      onClose={onClose}
      dismissible={!replace.isPending}
      footerButtons={[
        <Button
          key="cancel"
          variant="secondary"
          fullWidth={false}
          disabled={replace.isPending}
          onClick={onClose}
        >
          Cancel
        </Button>,
        <Button
          key="save"
          fullWidth={false}
          isLoading={replace.isPending}
          disabled={replace.isPending || !current.data}
          onClick={() => replace.mutate(editors, { onSuccess: onClose })}
        >
          Save
        </Button>,
      ]}
    >
      <div className="z-measure-editors">
        <p className="z-muted">
          Editors create, change and delete this source&apos;s measures over the
          tables they are granted.
        </p>
        {current.isLoading && <Spinner size="sm" />}
        <ErrorNotice error={current.error} />
        {current.data && (
          <>
            {editors.length === 0 ? (
              <p className="z-note">No editors yet.</p>
            ) : (
              <ul className="z-measure-editor-list">
                {editors.map((p) => {
                  const name = names.get(`${p.type}:${p.id}`);
                  return (
                    <li key={`${p.type}:${p.id}`}>
                      {name ? (
                        <span>{name}</span>
                      ) : (
                        <PrincipalLabel refValue={p} />
                      )}
                      <Button
                        size="sm"
                        variant="danger"
                        fullWidth={false}
                        title="Remove"
                        aria-label={`Remove ${name ?? p.id}`}
                        onClick={() =>
                          setEdited(editors.filter((e) => !same(e, p)))
                        }
                      >
                        <FontAwesomeIcon icon={faTrash} />
                      </Button>
                    </li>
                  );
                })}
              </ul>
            )}
            <PrincipalPicker
              value={null}
              onChange={(p) =>
                !editors.some((e) => same(e, p)) && setEdited([...editors, p])
              }
            />
          </>
        )}
        <ErrorNotice error={replace.error} />
      </div>
    </Modal>
  );
};
