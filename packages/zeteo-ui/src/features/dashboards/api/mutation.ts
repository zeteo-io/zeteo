import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toApiError, useZeteoApi, type ApiError } from "@/lib/api";
import type { AxiosInstance } from "axios";

/**
 * A mutation on zeteo's API that maps its failure to `ApiError` and, once it
 * succeeds, refreshes everything under each of `invalidate`'s keys.
 */
export const useApiMutation = <TResult, TVars>(
  call: (api: AxiosInstance, vars: TVars) => Promise<{ data: TResult }>,
  invalidate: unknown[][]
) => {
  const api = useZeteoApi();
  const queryClient = useQueryClient();
  return useMutation<TResult, ApiError, TVars>({
    mutationFn: async (vars) => {
      try {
        return (await call(api, vars)).data;
      } catch (err) {
        throw toApiError(err);
      }
    },
    onSuccess: () =>
      Promise.all(
        invalidate.map((queryKey) =>
          queryClient.invalidateQueries({ queryKey })
        )
      ),
  });
};
