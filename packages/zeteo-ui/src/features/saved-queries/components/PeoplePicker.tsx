import { faUser, faUserGroup } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { peopleSearchQuery } from "../api/usePeopleSearch";
import type { Principal } from "@/features/principals";
import { ErrorNotice } from "@/components/ErrorNotice";
import { Badge, SearchList } from "@kosmeo-ui/react";
import { useMemo, useState } from "react";
import type { ApiError } from "@/lib/api";

interface PeoplePickerProps {
  /** Called with the person or group the search result picked. */
  onPick: (principal: Principal) => void;
  /** With one kind there is no switch. */
  types?: ("user" | "group")[];
}

/** Searches people (and groups) through `/v1/me/principals`, which needs only `zeteo.data.read`. */
export const PeoplePicker = ({
  onPick,
  types = ["user", "group"],
}: PeoplePickerProps) => {
  const [type, setType] = useState<"user" | "group">(types[0]);
  const [error, setError] = useState<ApiError | null>(null);
  const searchQuery = useMemo(() => peopleSearchQuery(type, setError), [type]);

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
        value={null}
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
        onSelect={(p) => p && onPick(p)}
      />
      <ErrorNotice error={error} />
    </div>
  );
};
