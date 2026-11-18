import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toApiError, useZeteoApi, type ApiError } from "@/lib/api";
import type {
  CreateFileSource,
  FileSource,
  Staging,
  TableCorrection,
  UpdateColumn,
} from "./types";

/** Every file-source query sits under this key, so each change refreshes them all. */
const KEY = ["file-sources"];

const call = async <T>(request: () => Promise<{ data: T }>): Promise<T> => {
  try {
    return (await request()).data;
  } catch (err) {
    throw toApiError(err);
  }
};

/** The caller's own file sources (`mine`), or every one for an admin (`all`). */
export const useFileSources = (scope: "mine" | "all" = "mine") => {
  const api = useZeteoApi();
  return useQuery<FileSource[], ApiError>({
    queryKey: [...KEY, "list", scope],
    retry: false,
    queryFn: async ({ signal }) =>
      (
        await call(() =>
          api.get<{ data: FileSource[] }>("/v1/file-sources", {
            params: { scope },
            signal,
          })
        )
      ).data,
  });
};

export const useFileSource = (id: string) => {
  const api = useZeteoApi();
  return useQuery<FileSource, ApiError>({
    queryKey: [...KEY, id],
    retry: false,
    queryFn: ({ signal }) =>
      call(() => api.get<FileSource>(`/v1/file-sources/${id}`, { signal })),
  });
};

/** Sends a file to be staged: the answer is its preview. */
export const useUploadFile = () => {
  const api = useZeteoApi();
  return useMutation<Staging, ApiError, File>({
    mutationFn: (file) => {
      const form = new FormData();
      form.append("file", file);
      return call(() => api.post<Staging>("/v1/file-sources/uploads", form));
    },
  });
};

/** A change to file sources that answers with the source as it now is. */
const useSourceChange = <V>(
  request: (
    api: ReturnType<typeof useZeteoApi>,
    vars: V
  ) => Promise<{
    data: FileSource;
  }>
) => {
  const api = useZeteoApi();
  const queryClient = useQueryClient();
  return useMutation<FileSource, ApiError, V>({
    mutationFn: (vars) => call(() => request(api, vars)),
    onSuccess: (source) => {
      queryClient.setQueryData([...KEY, source.id], source);
      void queryClient.invalidateQueries({ queryKey: KEY });
      // Grants change with tables, owners and loads.
      void queryClient.invalidateQueries({ queryKey: ["grants"] });
    },
  });
};

export const useCreateFileSource = () =>
  useSourceChange<CreateFileSource>((api, body) =>
    api.post("/v1/file-sources", body)
  );

export const useRenameFileSource = (id: string) =>
  useSourceChange<string>((api, name) =>
    api.patch(`/v1/file-sources/${id}`, { name })
  );

export const useAddTables = (id: string) =>
  useSourceChange<{ staging_id: string; tables: TableCorrection[] }>(
    (api, body) => api.post(`/v1/file-sources/${id}/tables`, body)
  );

export const useReuploadTable = (id: string, tableId: string) =>
  useSourceChange<{ staging_id: string } & TableCorrection>((api, body) =>
    api.put(`/v1/file-sources/${id}/tables/${tableId}`, body)
  );

export const useUpdateColumn = (id: string, tableId: string) =>
  useSourceChange<{ columnId: string; body: UpdateColumn }>(
    (api, { columnId, body }) =>
      api.patch(
        `/v1/file-sources/${id}/tables/${tableId}/columns/${columnId}`,
        body
      )
  );

export const useTransferFileSource = (id: string) =>
  useSourceChange<{ user_id: string; keep_access: boolean }>((api, body) =>
    api.post(`/v1/file-sources/${id}/transfer`, body)
  );

/** A removal (204): the lists and the source are read again. */
const useRemoval = <V>(
  request: (api: ReturnType<typeof useZeteoApi>, vars: V) => Promise<unknown>
) => {
  const api = useZeteoApi();
  const queryClient = useQueryClient();
  return useMutation<void, ApiError, V>({
    mutationFn: async (vars) => {
      try {
        await request(api, vars);
      } catch (err) {
        throw toApiError(err);
      }
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: KEY });
      void queryClient.invalidateQueries({ queryKey: ["grants"] });
    },
  });
};

export const useRemoveTable = (id: string) =>
  useRemoval<string>((api, tableId) =>
    api.delete(`/v1/file-sources/${id}/tables/${tableId}`)
  );

export const useDeleteFileSource = () =>
  useRemoval<string>((api, id) => api.delete(`/v1/file-sources/${id}`));
