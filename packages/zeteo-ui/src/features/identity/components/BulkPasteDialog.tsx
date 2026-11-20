import { Alert, Button, Modal, TextArea } from "@kosmeo-ui/react";
import { useAddIdentityValues } from "../api/useIdentityValues";
import { ErrorNotice } from "@/components/ErrorNotice";
import { useDirectory } from "@/features/principals";
import { parsePasted } from "../bulkPaste";
import type { ApiError } from "@/lib/api";
import { useState } from "react";

const MAX = 1000;

/**
 * Adds values from pasted `email, value` lines. Emails are matched against the
 * directory; lines that name nobody are listed and left out. What is left goes
 * in one call, all or nothing.
 */
export const BulkPasteDialog = ({
  keyId,
  keyLabel,
  onClose,
}: {
  keyId: string;
  keyLabel: string;
  onClose: () => void;
}) => {
  const directory = useDirectory("admin");
  const add = useAddIdentityValues(keyId);
  const [text, setText] = useState("");
  const [unresolved, setUnresolved] = useState<string[]>([]);
  const [failure, setFailure] = useState<ApiError | null>(null);

  const submit = () => {
    setFailure(null);
    const { lines, bad } = parsePasted(text);
    const byEmail = new Map(
      (directory.data?.data ?? [])
        .filter((p) => p.type === "user" && p.email)
        .map((p) => [p.email!.toLowerCase(), p.id])
    );
    const missing = [...bad];
    const values: { user_id: string; value: string }[] = [];
    for (const l of lines) {
      const id = byEmail.get(l.email.toLowerCase());
      if (id) values.push({ user_id: id, value: l.value });
      else missing.push(l.line);
    }
    setUnresolved(missing);
    if (values.length === 0) return;
    if (values.length > MAX) {
      setFailure({
        status: null,
        code: "too_many",
        message: `Add up to ${MAX} values at a time.`,
      });
      return;
    }
    add.mutate(values, {
      // Lines that could not be matched stay in the box, so nothing is lost.
      onSuccess: () =>
        missing.length === 0 ? onClose() : setText(missing.join("\n")),
      onError: setFailure,
    });
  };

  return (
    <Modal
      show
      title={`Add ${keyLabel}`}
      onClose={onClose}
      dismissible={!add.isPending}
      footerButtons={[
        <Button
          key="cancel"
          variant="secondary"
          fullWidth={false}
          disabled={add.isPending}
          onClick={onClose}
        >
          Cancel
        </Button>,
        <Button
          key="add"
          fullWidth={false}
          isLoading={add.isPending}
          disabled={add.isPending || !text.trim() || !directory.data}
          onClick={submit}
        >
          Add values
        </Button>,
      ]}
    >
      <div className="z-identity-form">
        <TextArea
          label="One person per line"
          rows={8}
          placeholder={
            "ada@example.com, Northwest\nalan@example.com, Southeast"
          }
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <p className="z-muted">
          Each line is an email, then a tab or a comma, then the value. A value
          is kept exactly as written.
        </p>
        <ErrorNotice error={directory.error} />
        {unresolved.length > 0 && (
          <Alert variant="warning">
            <p>
              These lines name nobody we could match, so they were not sent:
            </p>
            <ul>
              {unresolved.map((line, i) => (
                <li key={i}>
                  <code>{line}</code>
                </li>
              ))}
            </ul>
          </Alert>
        )}
        <ErrorNotice error={failure} />
      </div>
    </Modal>
  );
};
