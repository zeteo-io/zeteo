import { api, toApiError, type ApiError } from "@/lib/api";
import type { Principal } from "./usePrincipalNames";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";

const DEBOUNCE_MS = 300;
const MIN_CHARS = 2;
const LIMIT = 10;

/** Users or groups whose name contains `q`, searched 300 ms after the last keystroke. */
export const usePrincipalSearch = (type: "user" | "group", q: string) => {
  const [debounced, setDebounced] = useState(q.trim());
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(q.trim()), DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [q]);

  const query = useQuery({
    queryKey: ["principals", "search", type, debounced],
    enabled: debounced.length >= MIN_CHARS,
    staleTime: 30_000,
    queryFn: async () => {
      try {
        const res = await api.get<{ data: Principal[] }>("/v1/principals", {
          params: { type, q: debounced, limit: LIMIT },
        });
        return res.data.data;
      } catch (err) {
        throw toApiError(err);
      }
    },
  });

  const active = debounced.length >= MIN_CHARS;
  return {
    results: active ? (query.data ?? []) : [],
    isLoading: active && query.isLoading,
    error: (query.error as ApiError | null) ?? null,
  };
};
