import { usePrincipalNames, type PrincipalRef } from "../api/usePrincipalNames";
import { Alert, Badge, Button, Input, Spinner } from "@kosmeo-ui/react";
import { PrincipalLabel, PrincipalLabelView } from "./PrincipalLabel";
import { usePrincipalSearch } from "../api/usePrincipalSearch";
import { ErrorNotice } from "@/components/ErrorNotice";
import { useState } from "react";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface PrincipalPickerProps {
  value: PrincipalRef | null;
  onChange: (value: PrincipalRef) => void;
  /** The kinds that can be chosen; with one, there is no switch. */
  types?: PrincipalRef["type"][];
}

// Own component so the lookup runs only once there is an id to look up.
const PastedId = ({
  refValue,
  onChange,
}: {
  refValue: PrincipalRef;
  onChange: (value: PrincipalRef) => void;
}) => {
  const { get, unavailable, error } = usePrincipalNames([refValue]);
  const principal = get(refValue);

  if (!principal && !error) return <Spinner size="sm" />;
  if (!principal && !unavailable) {
    // Refused or invalid (4xx): nothing says this id can be chosen.
    return (
      <div>
        <code>{refValue.id}</code> <small>{error?.message}</small>
      </div>
    );
  }
  const selectable = unavailable || principal?.status !== "orphaned";
  return (
    <div>
      <PrincipalLabelView
        refValue={refValue}
        principal={principal}
        unavailable={unavailable}
      />{" "}
      {selectable && (
        <Button
          size="sm"
          variant="secondary"
          fullWidth={false}
          onClick={() => onChange(refValue)}
        >
          Select
        </Button>
      )}
      {!selectable && (
        <small>
          {" "}
          Tereo has no such {refValue.type}, so it cannot be chosen.
        </small>
      )}
    </div>
  );
};

export const PrincipalPicker = ({
  value,
  onChange,
  types = ["user", "group"],
}: PrincipalPickerProps) => {
  const [chosenType, setType] = useState<"user" | "group">(types[0]);
  const type = types.includes(chosenType) ? chosenType : types[0];
  const [query, setQuery] = useState("");
  const [pasted, setPasted] = useState("");
  // kosmeo's Input is uncontrolled: a new key empties the field.
  const [pasteKey, setPasteKey] = useState(0);
  const search = usePrincipalSearch(type, query);
  const pastedId = pasted.trim().toLowerCase();

  return (
    <div>
      {value && (
        <p>
          Selected: <PrincipalLabel refValue={value} />
        </p>
      )}
      {types.length > 1 && (
        <div role="group" aria-label="Kind of principal">
          {types.map((kind) => (
            <Button
              key={kind}
              size="sm"
              fullWidth={false}
              variant={type === kind ? "primary" : "light"}
              aria-pressed={type === kind}
              onClick={() => setType(kind)}
            >
              {kind === "user" ? "Users" : "Groups"}
            </Button>
          ))}
        </div>
      )}

      <Input
        label={
          type === "user" ? "Search by name or email" : "Search by group name"
        }
        onChange={(e) => setQuery(e.target.value)}
        autoComplete="off"
      />
      {search.isLoading && <Spinner size="sm" />}
      <ErrorNotice error={search.error} />
      {search.results.length > 0 && (
        <ul>
          {search.results.map((p) => (
            <li key={`${p.type}:${p.id}`}>
              <Button
                variant="light"
                fullWidth
                align="left"
                onClick={() => onChange({ type: p.type, id: p.id })}
              >
                {p.name}
                {p.email ? ` (${p.email})` : ""}
                {p.status === "inactive" && (
                  <>
                    {" "}
                    <Badge size="sm" variant="secondary">
                      inactive
                    </Badge>
                  </>
                )}
              </Button>
            </li>
          ))}
        </ul>
      )}

      <Input
        key={pasteKey}
        label="Or paste an id"
        placeholder="A user, group or service account id"
        helperText={
          types.length > 1
            ? `Looked up as a ${type}; switch above for a group.`
            : `Looked up as a ${type}.`
        }
        onChange={(e) => setPasted(e.target.value)}
        autoComplete="off"
      />
      {pasted !== "" && !UUID.test(pastedId) && (
        <Alert variant="warning" size="sm">
          That is not an id (a UUID).
        </Alert>
      )}
      {UUID.test(pastedId) && (
        <PastedId
          key={`${type}:${pastedId}`}
          refValue={{ type, id: pastedId }}
          onChange={(selected) => {
            onChange(selected);
            setPasted("");
            setPasteKey((k) => k + 1);
          }}
        />
      )}
    </div>
  );
};
