import { useMutation, useQueryClient, useQuery } from "@tanstack/react-query";
import type { IdentityValue, MissingUser } from "./types";
import {
  toApiError,
  useCursorList,
  useZeteoApi,
  type ApiError,
} from "@/lib/api";

/** A key's values in creation order. */
export const useIdentityValues = (keyId: string, enabled = true) =>
  useCursorList<IdentityValue>(
    ["identity-keys", keyId, "values"],
    `/v1/identity-keys/${keyId}/values`,
    {},
    { enabled }
  );

/** People granted a rule using the key who hold no value under it. */
export const useMissingValues = (keyId: string, enabled: boolean) => {
  const api = useZeteoApi();
  return useQuery<MissingUser[], ApiError>({
    queryKey: ["identity-keys", keyId, "missing"],
    enabled,
    retry: false,
    queryFn: async () => {
      try {
        return (
          await api.get<{ users: MissingUser[] }>(
            `/v1/identity-keys/${keyId}/missing`
          )
        ).data.users;
      } catch (err) {
        throw toApiError(err);
      }
    },
  });
};

/** A new value close to another user's, which a source may match as the same. */
export interface NearDuplicate {
  code: "near_duplicate";
  value: string;
  /** The other user. */
  user_id: string;
}

export interface AddedValues {
  data: IdentityValue[];
  warnings: NearDuplicate[];
}

/** All or nothing: one call with up to 1,000 values. */
export const useAddIdentityValues = (keyId: string) => {
  const api = useZeteoApi();
  const queryClient = useQueryClient();
  return useMutation<
    AddedValues,
    ApiError,
    { user_id: string; value: string }[]
  >({
    mutationFn: async (values) => {
      try {
        const { data } = await api.post<AddedValues>(
          `/v1/identity-keys/${keyId}/values`,
          { values }
        );
        return { data: data.data, warnings: data.warnings ?? [] };
      } catch (err) {
        throw toApiError(err);
      }
    },
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ["identity-keys"] }),
  });
};

export const useDeleteIdentityValue = (keyId: string) => {
  const api = useZeteoApi();
  const queryClient = useQueryClient();
  return useMutation<void, ApiError, string>({
    mutationFn: async (id) => {
      try {
        await api.delete(`/v1/identity-keys/${keyId}/values/${id}`);
      } catch (err) {
        throw toApiError(err);
      }
    },
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ["identity-keys"] }),
  });
};
