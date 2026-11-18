import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toApiError, useZeteoApi, type ApiError } from "@/lib/api";

/** `GET /v1/connections/google`: who Zeteo signs in to Google as; never the key. */
export interface GoogleConnection {
  provider: "google";
  service_account_email: string;
  updated_at: string;
  updated_by: string;
}

const KEY = ["connections", "google"];

/** The Google connection; null while nobody has set a key (404 `google_not_configured`). */
export const useGoogleConnection = () => {
  const api = useZeteoApi();
  return useQuery<GoogleConnection | null, ApiError>({
    queryKey: KEY,
    retry: false,
    queryFn: async ({ signal }) => {
      try {
        return (
          await api.get<GoogleConnection>("/v1/connections/google", { signal })
        ).data;
      } catch (err) {
        const error = toApiError(err);
        if (error.code === "google_not_configured") return null;
        throw error;
      }
    },
  });
};

/** Sets the service-account key: its JSON as pasted or read from the file. */
export const useSetGoogleKey = () => {
  const api = useZeteoApi();
  const queryClient = useQueryClient();
  return useMutation<GoogleConnection, ApiError, string>({
    // The body is the key: keep nothing once the dialog is gone.
    gcTime: 0,
    // The body is the key: keep nothing once the dialog is gone.
    mutationFn: async (key) => {
      try {
        return (
          await api.put<GoogleConnection>("/v1/connections/google", {
            service_account_key: key,
          })
        ).data;
      } catch (err) {
        throw toApiError(err);
      }
    },
    onSuccess: (connection) => {
      queryClient.setQueryData(KEY, connection);
    },
  });
};
