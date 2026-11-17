import { toApiError, useZeteoApi, type ApiError } from "@/lib/api";
import type { Principal } from "./usePrincipalNames";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef } from "react";

const MIN_CHARS = 2;
const LIMIT = 10;

/**
 * A query hook in the shape kosmeo's SearchList calls on each render: it
 * debounces the input itself and passes the text it wants searched.
 */
export const principalSearchQuery =
  (type: "user" | "group", onError?: (error: ApiError | null) => void) =>
  // A hook by contract: SearchList calls it on every render.
  (input: string, _searchKey: string, max: number) => {
    const api = useZeteoApi();
    const q = input.trim();
    const query = useQuery<Principal[], Error>({
      queryKey: ["principals", "search", type, q],
      enabled: q.length >= MIN_CHARS,
      staleTime: 30_000,
      queryFn: async () => {
        try {
          const res = await api.get<{ data: Principal[] }>("/v1/principals", {
            params: { type, q, limit: Math.min(max, LIMIT) },
          });
          return res.data.data;
        } catch (err) {
          throw toApiError(err) as unknown as Error;
        }
      },
    });
    // SearchList shows a failed search as no results; the picker says why.
    const error = (query.error as ApiError | null) ?? null;
    const report = useRef(onError);
    report.current = onError;
    useEffect(() => report.current?.(error), [error]);
    return query;
  };
