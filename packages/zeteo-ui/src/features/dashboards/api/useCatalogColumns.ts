import { toApiError, useZeteoApi, type ApiError } from "@/lib/api";
import type { CatalogSourceColumns } from "../editing";
import { useQuery } from "@tanstack/react-query";

/** The caller's catalogue with its columns and relations (the key My Zeteo's catalogue uses). */
export const useCatalogColumns = (enabled = true) => {
  const api = useZeteoApi();
  return useQuery<CatalogSourceColumns[], ApiError>({
    queryKey: ["catalog"],
    enabled,
    retry: false,
    queryFn: async () => {
      try {
        return (
          await api.get<{ sources: CatalogSourceColumns[] }>("/v1/catalog")
        ).data.sources;
      } catch (err) {
        throw toApiError(err);
      }
    },
  });
};
