import { useSource } from "@/features/sources/api/useSource";
import { useAuth } from "@/lib/auth";

/** Write controls need `zeteo.sources.write` and a source that is not archived. */
export const useCanEditCatalogue = (sourceId: string): boolean => {
  const { can } = useAuth();
  const { data: source } = useSource(sourceId);
  return can("zeteo.sources.write") && !!source && !source.archived_at;
};
