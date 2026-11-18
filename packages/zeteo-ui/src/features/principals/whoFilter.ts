import type { InfiniteScrollMenuFilter } from "@kosmeo-ui/react";
import type { Principal } from "./api/usePrincipalNames";
import type { PrincipalType } from "./api/types";

type SelectFilter = Extract<InfiniteScrollMenuFilter, { type: "SELECT" }>;

/** The Who filter's default key: its value comes back as `filter[who]`. */
export const WHO_KEY = "who";

/** A Who option's id: `user:<id>` or `group:<id>`. */
export const whoId = (type: PrincipalType, id: string) => `${type}:${id}`;

const label = (p: Pick<Principal, "type" | "name" | "email">) => {
  const name = p.name ?? p.email ?? `Unknown ${p.type}`;
  return p.type === "group" ? `${name} (group)` : name;
};

interface WhoFilterOptions {
  /** Defaults to "Who". */
  title?: string;
  /** Defaults to `WHO_KEY`; a page with two such filters gives each its own. */
  dataKey?: string;
  /** The option to start chosen (`whoId`); one the directory lacks is added as unknown. */
  selected?: string;
  /** Only these kinds, e.g. `["user"]` where only a person can be chosen. */
  only?: PrincipalType[];
}

/**
 * kosmeo's built-in SELECT filter over the whole directory, by name; its own
 * search box finds a person. TableFilters starts over when its definitions
 * change, so memoize the result on the directory and the selection.
 */
export const whoFilter = (
  principals: Principal[],
  { title = "Who", dataKey = WHO_KEY, selected, only }: WhoFilterOptions = {}
): SelectFilter => {
  const options = principals
    .filter((p) => !only || only.includes(p.type))
    .map((p) => ({ id: whoId(p.type, p.id), name: label(p) }))
    .sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: "base" })
    );
  // A deep link to someone the directory does not list (gone, or past its
  // cap) keeps its choice, so the filter does not drop it on mount.
  if (selected && !options.some((o) => o.id === selected)) {
    const type = selected.split(":")[0] as PrincipalType;
    options.push({
      id: selected,
      name: label({ type, name: null, email: null }),
    });
  }
  return {
    type: "SELECT",
    title,
    dataKey,
    options: options.map((o) => ({ ...o, selected: o.id === selected })),
  };
};

/** The principal chosen in a Who filter (`dataKey`), as the list APIs take it: both keys, or `{}` for none. */
export const parseWho = (
  params: Record<string, string>,
  dataKey = WHO_KEY
): { principal_type?: PrincipalType; principal_id?: string } => {
  const value = params[`filter[${dataKey}]`] ?? "";
  const at = value.indexOf(":");
  const type = value.slice(0, at);
  const id = value.slice(at + 1);
  return at > 0 && id && (type === "user" || type === "group")
    ? { principal_type: type, principal_id: id }
    : {};
};
