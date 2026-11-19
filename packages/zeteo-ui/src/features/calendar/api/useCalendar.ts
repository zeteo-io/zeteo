import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toApiError, useZeteoApi, type ApiError } from "@/lib/api";
import type { Calendar, CalendarBody } from "./types";

const KEY = ["calendar"];

export const useCalendar = () => {
  const api = useZeteoApi();
  return useQuery<Calendar, ApiError>({
    queryKey: KEY,
    retry: false,
    queryFn: async ({ signal }) => {
      try {
        return (await api.get<Calendar>("/v1/calendar", { signal })).data;
      } catch (err) {
        throw toApiError(err);
      }
    },
  });
};

/** Replaces the whole calendar. */
export const useSaveCalendar = () => {
  const api = useZeteoApi();
  const queryClient = useQueryClient();
  return useMutation<Calendar, ApiError, CalendarBody>({
    mutationFn: async (body) => {
      try {
        return (await api.put<Calendar>("/v1/calendar", body)).data;
      } catch (err) {
        throw toApiError(err);
      }
    },
    onSuccess: (data) => queryClient.setQueryData(KEY, data),
  });
};
