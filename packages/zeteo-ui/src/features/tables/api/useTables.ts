import { useCursorList } from "@/lib/api";
import type { Table } from "./types";

/** A source's tables in schema and name order; missing ones only when asked for. */
export const useTables = (
  sourceId: string | undefined,
  { includeMissing = false }: { includeMissing?: boolean } = {}
) =>
  useCursorList<Table>(
    ["sources", sourceId, "tables"],
    `/v1/sources/${sourceId}/tables`,
    { include_missing: includeMissing ? true : undefined },
    { enabled: sourceId !== undefined }
  );
