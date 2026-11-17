import { toApiError, useZeteoApi, type ApiError } from "@/lib/api";
import { useQuery } from "@tanstack/react-query";
import type { CatalogSource } from "./types";

/** What the person may query: their own view of the catalogue. */
export const useCatalog = () => {
  const api = useZeteoApi();
  return useQuery<CatalogSource[], ApiError>({
    queryKey: ["catalog"],
    retry: false,
    queryFn: async () => {
      try {
        return (await api.get<{ sources: CatalogSource[] }>("/v1/catalog")).data
          .sources;
      } catch (err) {
        throw toApiError(err);
      }
    },
  });
};
