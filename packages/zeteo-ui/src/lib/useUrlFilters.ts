import { useSearchParams } from "react-router-dom";
import { useEffect } from "react";

type Filters = object;

const queryOf = (filters: Filters) => {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (typeof value === "string" && value) query.set(key, value);
  }
  return query.toString();
};

/**
 * Filters kept in the address. `parse` keeps only valid values; whatever it
 * drops is rewritten out of the address in place, while a person's own change
 * (`setFilters`) is a step of its own in the history.
 */
export const useUrlFilters = <F extends Filters>(
  keys: string[],
  parse: (params: URLSearchParams) => F
) => {
  const [params, setParams] = useSearchParams();
  const filters = parse(params);
  const cleaned = queryOf(filters);
  const current = queryOf(
    Object.fromEntries(keys.map((key) => [key, params.get(key) ?? undefined]))
  );
  useEffect(() => {
    if (cleaned !== current) {
      setParams(new URLSearchParams(cleaned), { replace: true });
    }
  }, [cleaned, current, setParams]);
  const setFilters = (next: F) => setParams(new URLSearchParams(queryOf(next)));
  return [filters, setFilters] as const;
};
