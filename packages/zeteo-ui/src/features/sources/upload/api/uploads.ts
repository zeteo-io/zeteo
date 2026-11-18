import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toApiError, useZeteoApi, type ApiError } from "@/lib/api";
import type { Source } from "../../api/types";
import { useCallback } from "react";
import type {
  CreateSheetsSource,
  CreateUploadSource,
  SheetStaging,
  Staging,
  TableCorrection,
  UpdateColumn,
} from "./types";

/** Every source query sits under this key, so each change refreshes them all. */
const KEY = ["sources"];

const call = async <T>(request: () => Promise<{ data: T }>): Promise<T> => {
  try {
    return (await request()).data;
  } catch (err) {
    throw toApiError(err);
  }
};

// The API's largest page, and how many My sources reads at most.
const PAGE_LIMIT = 100;
const MAX_PAGES = 50;

interface Page {
  data: Source[];
  next_cursor: string | null;
}

/** The caller's own sources (files and Google Sheets), deleted ones left out: My sources. */
export const useMyUploads = () => {
  const api = useZeteoApi();
  return useQuery<Source[], ApiError>({
    queryKey: [...KEY, "mine", "upload"],
    retry: false,
    queryFn: async ({ signal }) => {
      const sources: Source[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < MAX_PAGES; page++) {
        const body = await call(() =>
          api.get<Page>("/v1/sources", {
            params: {
              // Only an upload or a Google Sheets source has an owner.
              owner_id: "me",
              limit: PAGE_LIMIT,
              ...(cursor ? { cursor } : {}),
            },
            signal,
          })
        );
        sources.push(...body.data);
        if (!body.next_cursor) return sources;
        cursor = body.next_cursor;
      }
      return sources;
    },
  });
};

/** Sends a file to be staged: the answer is its preview. */
export const useUploadFile = () => {
  const api = useZeteoApi();
  return useMutation<Staging, ApiError, File>({
    mutationFn: (file) => {
      const form = new FormData();
      form.append("file", file);
      return call(() => api.post<Staging>("/v1/uploads", form));
    },
  });
};

/** Stages a Google Sheet from its link, or an existing Sheets source's own spreadsheet: the answer is its preview. */
export const useStageSheet = () => {
  const api = useZeteoApi();
  return useMutation<
    SheetStaging,
    ApiError,
    { url: string } | { source_id: string }
  >({
    mutationFn: (body) =>
      call(() => api.post<SheetStaging>("/v1/uploads/links", body)),
  });
};

/**
 * Discards a staging the person left without using: its tables are dropped
 * and its space freed. Fire-and-forget: a staging that is already gone, or a
 * failure, changes nothing for them (it expires anyway).
 */
export const useDiscardStaging = () => {
  const api = useZeteoApi();
  return useCallback(
    (stagingId: string) => {
      void Promise.resolve()
        .then(() => api.delete(`/v1/uploads/${stagingId}`))
        .catch(() => undefined);
    },
    [api]
  );
};

/** A change to an upload source that answers with the source as it now is. */
const useSourceChange = <V>(
  request: (
    api: ReturnType<typeof useZeteoApi>,
    vars: V
  ) => Promise<{
    data: Source;
  }>
) => {
  const api = useZeteoApi();
  const queryClient = useQueryClient();
  return useMutation<Source, ApiError, V>({
    mutationFn: (vars) => call(() => request(api, vars)),
    onSuccess: (source) => {
      queryClient.setQueryData([...KEY, source.id], source);
      // The catalogue's tables and columns change with loads, retypes and
      // renames; grants with tables, owners and loads.
      void queryClient.invalidateQueries({ queryKey: KEY });
      void queryClient.invalidateQueries({ queryKey: ["grants"] });
    },
  });
};

export const useCreateUploadSource = () =>
  useSourceChange<Omit<CreateUploadSource, "type">>((api, body) =>
    api.post("/v1/sources", { type: "upload", ...body })
  );

export const useCreateSheetsSource = () =>
  useSourceChange<Omit<CreateSheetsSource, "type">>((api, body) =>
    api.post("/v1/sources", { type: "google-sheets", ...body })
  );

export const useAddTables = (id: string) =>
  useSourceChange<{ staging_id: string; tables: TableCorrection[] }>(
    (api, body) => api.post(`/v1/sources/${id}/tables`, body)
  );

export const useReuploadTable = (id: string, tableId: string) =>
  useSourceChange<{ staging_id: string } & TableCorrection>((api, body) =>
    api.put(`/v1/sources/${id}/tables/${tableId}`, body)
  );

export const useUpdateColumn = (id: string, tableId: string) =>
  useSourceChange<{ columnId: string; body: UpdateColumn }>(
    (api, { columnId, body }) =>
      api.patch(`/v1/sources/${id}/tables/${tableId}/columns/${columnId}`, body)
  );

export const useTransferSource = (id: string) =>
  useSourceChange<{ user_id: string; keep_access: boolean }>((api, body) =>
    api.post(`/v1/sources/${id}/transfer`, body)
  );

/** A removal (204): the sources and grants are read again. */
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
    api.delete(`/v1/sources/${id}/tables/${tableId}`)
  );

/** Deletes an upload source and its data (a database source is archived instead). */
export const useDeleteUploadSource = () =>
  useRemoval<string>((api, id) => api.delete(`/v1/sources/${id}`));
