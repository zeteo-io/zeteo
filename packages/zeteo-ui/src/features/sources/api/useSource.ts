import { api, toApiError, type ApiError } from "@/lib/api";
import { useQuery } from "@tanstack/react-query";
import type { Source } from "./types";

export const useSource = (sourceId: string) =>
  useQuery<Source, ApiError>({
    queryKey: ["sources", sourceId],
    queryFn: async () => {
      try {
        return (await api.get<Source>(`/v1/sources/${sourceId}`)).data;
      } catch (err) {
        throw toApiError(err);
      }
    },
  });
