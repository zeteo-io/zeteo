import { Button, FileDropZone, Modal, TextArea } from "@kosmeo-ui/react";
import { useSetGoogleKey } from "../api/useGoogleConnection";
import { ErrorNotice } from "@/components/ErrorNotice";
import { useState } from "react";
import "./styles.css";

/** The key is a small JSON file; anything bigger is not one. */
const MAX_KEY_BYTES = 64 * 1024;

/** Sets the Google service-account key from pasted JSON or the downloaded `.json`. */
export const GoogleKeyDialog = ({ onClose }: { onClose: () => void }) => {
  const set = useSetGoogleKey();
  const [text, setText] = useState("");
  const [problem, setProblem] = useState<string | null>(null);

  const read = async (files: File[]) => {
    const file = files[0];
    if (!file) return;
    if (file.size > MAX_KEY_BYTES) {
      setProblem("That file is too big to be a service account key.");
      return;
    }
    setProblem(null);
    set.reset();
    setText(await file.text());
  };

  const save = () => {
    if (!text.trim() || set.isPending) return;
    set.mutate(text, { onSuccess: onClose });
  };

  return (
    <Modal
      show
      size="lg"
      title="Google service account key"
      onClose={onClose}
      dismissible={!set.isPending}
      footerButtons={[
        <Button
          key="cancel"
          variant="secondary"
          fullWidth={false}
          disabled={set.isPending}
          onClick={onClose}
        >
          Cancel
        </Button>,
        <Button
          key="save"
          fullWidth={false}
          isLoading={set.isPending}
          disabled={!text.trim() || set.isPending}
          onClick={save}
        >
          Save key
        </Button>,
      ]}
    >
      <div className="z-connections-dialog">
        <p className="z-note">
          Paste the JSON key of a Google service account with the Sheets API
          enabled, or choose the downloaded <code>.json</code> file. People then
          share their sheets with its email address as a Viewer. Zeteo keeps the
          key encrypted and never shows it again.
        </p>
        <FileDropZone
          accept=".json,application/json"
          maxFiles={1}
          label="Drop the key file here"
          onFilesSelected={read}
          onError={setProblem}
        />
        {problem && <p className="z-fs-problem">{problem}</p>}
        <TextArea
          label="Service account key"
          rows={8}
          value={text}
          placeholder='{ "type": "service_account", … }'
          onChange={(e) => {
            setText(e.target.value);
            if (set.error) set.reset();
          }}
        />
        <ErrorNotice error={set.error} />
      </div>
    </Modal>
  );
};
