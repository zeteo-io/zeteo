import { faUser, faUserGroup } from "@fortawesome/free-solid-svg-icons";
import { principalSearchQuery } from "../api/usePrincipalSearch";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { ErrorNotice } from "@/components/ErrorNotice";
import { PrincipalLabelView } from "./PrincipalLabel";
import { useMemo, useState } from "react";
import type { ApiError } from "@/lib/api";
import {
  usePrincipalNames,
  type Principal,
  type PrincipalRef,
} from "../api/usePrincipalNames";
import {
  Alert,
  Badge,
  Button,
  Input,
  SearchList,
  Spinner,
} from "@kosmeo-ui/react";

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
  const [pasted, setPasted] = useState("");
  // kosmeo's Input is uncontrolled: a new key empties the field.
  const [pasteKey, setPasteKey] = useState(0);
  // The chosen principal's name, so the search field can show it.
  const chosen = usePrincipalNames(value ? [value] : []);
  // One hook per kind: SearchList calls it on every render.
  const [searchError, setSearchError] = useState<ApiError | null>(null);
  const searchQuery = useMemo(
    () => principalSearchQuery(type, setSearchError),
    [type]
  );
  const pastedId = pasted.trim().toLowerCase();
  // Pasting an id is the way to pick a service account; it stays out of
  // the way unless asked for.
  const [pasting, setPasting] = useState(false);

  return (
    <div className="z-picker">
      {types.length > 1 && (
        <div
          className="z-segmented"
          role="group"
          aria-label="Kind of principal"
        >
          {types.map((kind) => (
            <button
              key={kind}
              type="button"
              className="z-segmented-option"
              aria-pressed={type === kind}
              onClick={() => setType(kind)}
            >
              <FontAwesomeIcon icon={kind === "user" ? faUser : faUserGroup} />
              {kind === "user" ? "Users" : "Groups"}
            </button>
          ))}
        </div>
      )}

      <SearchList<Principal>
        key={type}
        label={
          type === "user" ? "Search by name or email" : "Search by group name"
        }
        placeholder={
          type === "user"
            ? "Type 3 or more letters of a name or email"
            : "Type 3 or more letters of a group name"
        }
        queryFn={searchQuery}
        searchKey="q"
        labelKey="name"
        max={10}
        longDropDown
        value={
          value && value.type === type ? (chosen.get(value) ?? null) : null
        }
        renderOption={(p) => ({
          label: p.name ?? p.id,
          node: (
            <span className="z-picker-option">
              <FontAwesomeIcon
                className="z-principal-icon"
                icon={p.type === "group" ? faUserGroup : faUser}
              />
              <span>{p.name ?? p.id}</span>
              {p.email && <span className="z-principal-email">{p.email}</span>}
              {p.status === "inactive" && (
                <Badge size="sm" variant="secondary">
                  Inactive
                </Badge>
              )}
            </span>
          ),
        })}
        onSelect={(p) => p && onChange({ type: p.type, id: p.id })}
      />
      <ErrorNotice error={searchError} />

      {!pasting ? (
        <Button
          size="sm"
          variant="link"
          fullWidth={false}
          onClick={() => setPasting(true)}
        >
          Paste an id instead (for a service account)
        </Button>
      ) : (
        <>
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
        </>
      )}
    </div>
  );
};
