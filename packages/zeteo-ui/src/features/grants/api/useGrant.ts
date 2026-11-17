import { toApiError, useZeteoApi, type ApiError } from "@/lib/api";
import { useQuery } from "@tanstack/react-query";
import type { Grant } from "./types";

export const useGrant = (grantId: string) => {
  const api = useZeteoApi();
  return useQuery<Grant, ApiError>({
    queryKey: ["grants", grantId],
    queryFn: async () => {
      try {
        return (await api.get<Grant>(`/v1/grants/${grantId}`)).data;
      } catch (err) {
        throw toApiError(err);
      }
    },
  });
};
