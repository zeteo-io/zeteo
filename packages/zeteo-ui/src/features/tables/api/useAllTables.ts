import { useTables } from "./useTables";
import type { Table } from "./types";
import { useEffect } from "react";

export const tableLabel = (table: Pick<Table, "schema_name" | "name">) =>
  `${table.schema_name}.${table.name}`;

/**
 * Every table of a source, missing ones included, for resolving ids to names:
 * reads page after page until the API has no more.
 */
export const useAllTables = (sourceId: string | undefined) => {
  const { items, isLoading, error, hasMore, loadMore } = useTables(sourceId, {
    includeMissing: true,
  });
  useEffect(() => {
    if (hasMore) loadMore();
  }, [hasMore, items.length, loadMore]);

  const byId = new Map(items.map((t) => [t.id, t]));
  return {
    tables: items,
    isLoading: isLoading || hasMore,
    error,
    /** `schema.name`, or the raw id while the table is not (yet) known. */
    labelFor: (id: string) => {
      const table = byId.get(id);
      return table ? tableLabel(table) : id;
    },
  };
};
