import { useAllRelations } from "@/features/relations";
import type { TableDetail } from "@/features/tables";
import { useQueries } from "@tanstack/react-query";
import { useAllTables } from "@/features/tables";
import { useZeteoApi } from "@/lib/api";

const isTime = (type: string) => type === "date" || type === "timestamp";

/**
 * The date and timestamp columns a measure on `tableName` can be dated by:
 * the table's own, then those of the tables its to-one relations reach, as
 * `relation.column` (one step through).
 */
export const useDateColumns = (sourceId: string, tableName: string) => {
  const api = useZeteoApi();
  const { tables } = useAllTables(sourceId, { includeMissing: false });
  const { relations } = useAllRelations(sourceId);
  const counts = new Map<string, number>();
  for (const t of tables) counts.set(t.name, (counts.get(t.name) ?? 0) + 1);
  const home = tables.find((t) =>
    counts.get(t.name) === 1
      ? t.name === tableName
      : `${t.schema_name}.${t.name}` === tableName
  );
  const reached = home
    ? relations.filter(
        (r) => r.from_table_id === home.id && !r.to_many && !r.missing_since
      )
    : [];
  const wanted = home
    ? [
        { prefix: "", id: home.id },
        ...reached.map((r) => ({ prefix: `${r.name}.`, id: r.to_table_id })),
      ]
    : [];
  const details = useQueries({
    queries: wanted.map(({ id }) => ({
      queryKey: ["sources", sourceId, "tables", id],
      retry: false,
      queryFn: async () =>
        (await api.get<TableDetail>(`/v1/sources/${sourceId}/tables/${id}`))
          .data,
    })),
  });
  const options = wanted.flatMap(({ prefix }, i) =>
    (details[i]?.data?.columns ?? [])
      .filter((c) => !c.missing_since && isTime(c.type))
      .map((c) => `${prefix}${c.name}`)
  );
  return [...new Set(options)];
};
