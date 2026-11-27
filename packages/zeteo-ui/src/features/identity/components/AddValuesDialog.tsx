import { useDirectory, type Principal } from "@/features/principals";
import { faPlus, faTrash } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { ErrorNotice } from "@/components/ErrorNotice";
import { parsePasted } from "../bulkPaste";
import type { ApiError } from "@/lib/api";
import { useState } from "react";
import {
  useAddIdentityValues,
  type NearDuplicate,
} from "../api/useIdentityValues";
import {
  Alert,
  Button,
  Input,
  Modal,
  SearchSelect,
  TextArea,
} from "@kosmeo-ui/react";

const MAX = 1000;

type Mode = "rows" | "paste";
const MODES: [Mode, string][] = [
  ["rows", "One by one"],
  ["paste", "Paste a list"],
];

interface Row {
  key: number;
  person: Principal | null;
  value: string;
}
let nextKey = 0;
const emptyRow = (): Row => ({ key: nextKey++, person: null, value: "" });

const userLabel = (p: Principal) =>
  p.email ? `${p.name ?? p.email} (${p.email})` : (p.name ?? p.id);

/**
 * Adds values for a key: typed one person at a time, or pasted as
 * `email, value` lines. Either way what is sent is one call, all or nothing.
 * Pasted emails are matched to the directory ignoring case; one that matches
 * nobody, or more than one person, is listed and left out, never guessed.
 */
export const AddValuesDialog = ({
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
  const [mode, setMode] = useState<Mode>("rows");
  const [rows, setRows] = useState<Row[]>(() => [emptyRow()]);
  const [text, setText] = useState("");
  const [unresolved, setUnresolved] = useState<string[]>([]);
  const [ambiguous, setAmbiguous] = useState<string[]>([]);
  const [failure, setFailure] = useState<ApiError | null>(null);
  // After a save: new values close to another person's, shown before closing.
  const [near, setNear] = useState<NearDuplicate[]>([]);

  const users = (directory.data?.data ?? []).filter((p) => p.type === "user");
  const filled = rows.filter((r) => r.person || r.value.trim());
  const complete = (r: Row) => r.person !== null && r.value.trim() !== "";
  const ready =
    !!directory.data &&
    (mode === "rows"
      ? filled.length > 0 && filled.every(complete)
      : !!text.trim());

  /**
   * Sends `values`; `left` are the pasted lines not sent, kept in the box.
   * Closes when nothing is left and no value is close to another person's.
   */
  const send = (
    values: { user_id: string; value: string }[],
    left: string[]
  ) => {
    if (values.length > MAX) {
      setFailure({
        status: null,
        code: "too_many",
        message: `Add up to ${MAX} values at a time.`,
      });
      return;
    }
    add.mutate(values, {
      onSuccess: ({ warnings }) => {
        if (warnings.length === 0 && left.length === 0) {
          onClose();
          return;
        }
        setNear(warnings);
        setRows([emptyRow()]);
        setText(left.join("\n"));
      },
      onError: setFailure,
    });
  };

  const submit = () => {
    setFailure(null);
    setNear([]);
    if (mode === "rows") {
      send(
        filled.map((r) => ({ user_id: r.person!.id, value: r.value.trim() })),
        []
      );
      return;
    }
    const { lines, bad } = parsePasted(text);
    const byEmail = new Map<string, string[]>();
    for (const p of users) {
      if (!p.email) continue;
      const k = p.email.toLowerCase();
      byEmail.set(k, [...(byEmail.get(k) ?? []), p.id]);
    }
    const missing = [...bad];
    const unclear: string[] = [];
    const values: { user_id: string; value: string }[] = [];
    for (const l of lines) {
      const ids = byEmail.get(l.email.toLowerCase()) ?? [];
      if (ids.length === 1) values.push({ user_id: ids[0], value: l.value });
      else if (ids.length > 1) unclear.push(l.line);
      else missing.push(l.line);
    }
    setUnresolved(missing);
    setAmbiguous(unclear);
    if (values.length === 0) return;
    // Lines that were not sent stay in the box, so nothing is lost.
    send(values, [...missing, ...unclear]);
  };

  const taken = failure?.code === "identity_value_taken";
  // The clashing value's line stays in the box and is called out below it.
  const clash = taken
    ? text
        .split(/\r?\n/)
        .find((l) => failure?.taken_value && l.includes(failure.taken_value))
    : undefined;

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
          {near.length > 0 ? "Close" : "Cancel"}
        </Button>,
        <Button
          key="add"
          fullWidth={false}
          isLoading={add.isPending}
          disabled={add.isPending || !ready}
          onClick={submit}
        >
          Add values
        </Button>,
      ]}
    >
      <div className="z-identity-form">
        <div className="z-segmented" role="group" aria-label="How to add">
          {MODES.map(([m, label]) => (
            <button
              key={m}
              type="button"
              className="z-segmented-option"
              aria-pressed={mode === m}
              onClick={() => setMode(m)}
            >
              {label}
            </button>
          ))}
        </div>
        {mode === "rows" ? (
          <>
            <div className="z-identity-rows">
              {rows.map((r, i) => (
                <div key={r.key} className="z-identity-row">
                  <SearchSelect<Principal>
                    label={i === 0 ? "Person" : undefined}
                    placeholder="Search people"
                    value={r.person}
                    options={users}
                    getOptionLabel={userLabel}
                    getOptionKey={(p) => p.id}
                    longDropDown
                    onSelect={(p) =>
                      setRows(
                        rows.map((x) =>
                          x.key === r.key ? { ...x, person: p } : x
                        )
                      )
                    }
                  />
                  <Input
                    label={i === 0 ? "Value" : undefined}
                    aria-label={`Value ${i + 1}`}
                    error={
                      taken &&
                      failure.taken_value &&
                      r.value.trim() === failure.taken_value
                        ? "Another person holds this value"
                        : undefined
                    }
                    value={r.value}
                    onChange={(e) =>
                      setRows(
                        rows.map((x) =>
                          x.key === r.key ? { ...x, value: e.target.value } : x
                        )
                      )
                    }
                  />
                  <Button
                    variant="danger"
                    fullWidth={false}
                    title="Remove row"
                    aria-label={`Remove row ${i + 1}`}
                    disabled={rows.length === 1}
                    onClick={() => setRows(rows.filter((x) => x.key !== r.key))}
                  >
                    <FontAwesomeIcon icon={faTrash} />
                  </Button>
                </div>
              ))}
            </div>
            <div>
              <Button
                size="sm"
                variant="success"
                fullWidth={false}
                onClick={() => setRows([...rows, emptyRow()])}
              >
                <FontAwesomeIcon icon={faPlus} /> Another person
              </Button>
            </div>
          </>
        ) : (
          <>
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
              Each line is an email, then a tab or a comma, then the value.
              Spaces around the value are dropped.
            </p>
          </>
        )}
        <ErrorNotice error={directory.error} />
        {mode === "paste" && unresolved.length > 0 && (
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
            {directory.data?.truncated && (
              <p>
                Some people could not be looked up: the directory is too large
                to load in full.
              </p>
            )}
          </Alert>
        )}
        {mode === "paste" && ambiguous.length > 0 && (
          <Alert variant="warning">
            <p>
              These emails match more than one person (they differ only in
              capitals), so they were not sent:
            </p>
            <ul>
              {ambiguous.map((line, i) => (
                <li key={i}>
                  <code>{line}</code>
                </li>
              ))}
            </ul>
          </Alert>
        )}
        {taken && (
          <Alert variant="danger">
            <p>
              {failure.taken_value ? (
                <>
                  The value <code>{failure.taken_value}</code> is already held
                  by another person, so nothing was added.
                </>
              ) : (
                failure.message
              )}
            </p>
            {clash && (
              <p>
                Line: <code>{clash}</code>
              </p>
            )}
          </Alert>
        )}
        {near.length > 0 && (
          <Alert variant="warning">
            <p>
              Added. These values are close to another person's (the same but
              for capitals, spaces or how a number is written), and a source may
              match them as the same:
            </p>
            <ul>
              {near.map((d, i) => {
                const other = users.find((p) => p.id === d.user_id);
                return (
                  <li key={i}>
                    <code>{d.value}</code> is close to a value{" "}
                    {other ? userLabel(other) : d.user_id} holds.
                  </li>
                );
              })}
            </ul>
          </Alert>
        )}
        {!taken && <ErrorNotice error={failure} />}
      </div>
    </Modal>
  );
};
