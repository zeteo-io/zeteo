import { useSource } from "@/features/sources";
import { useAuth } from "@tereo-io/react";

/** Write controls need `zeteo.sources.write` and a source that is not archived. */
export const useCanEditCatalogue = (sourceId: string): boolean => {
  const { hasPermission } = useAuth();
  const { data: source } = useSource(sourceId);
  return (
    hasPermission("zeteo.sources.write") && !!source && !source.archived_at
  );
};
