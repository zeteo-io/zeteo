import { useQueries, useQueryClient } from "@tanstack/react-query";
import { api, toApiError, type ApiError } from "@/lib/api";
import { useMemo } from "react";

export type PrincipalRef = { type: "user" | "group"; id: string };

export interface Principal extends PrincipalRef {
  name: string | null;
  email?: string | null;
  status: "active" | "inactive" | "orphaned";
}

const BATCH = 100;
const STALE_MS = 60_000;

const refKey = (ref: PrincipalRef) => ["principals", "ref", ref.type, ref.id];
const textKey = (ref: PrincipalRef) => `${ref.type}:${ref.id}`;

export const lookupPrincipals = async (
  refs: PrincipalRef[]
): Promise<Principal[]> => {
  try {
    const res = await api.post<{ data: Principal[] }>("/v1/principals/lookup", {
      principals: refs,
    });
    return res.data.data;
  } catch (err) {
    throw toApiError(err);
  }
};

/**
 * Names for principals, looked up in batches of at most 100 distinct refs.
 * Each answer is kept per ref for 60 s, so paging through a list asks only
 * for the names it does not already have.
 */
export const usePrincipalNames = (refs: PrincipalRef[]) => {
  const client = useQueryClient();

  // Planned when the set of refs changes, not on every cache write, so the
  // chunk queries stay mounted (and observed) until their answers are in.
  const signature = [...new Set(refs.map(textKey))].sort().join(",");
  const chunks = useMemo(() => {
    const distinct = [...new Map(refs.map((r) => [textKey(r), r])).values()];
    const missing = distinct.filter((ref) => {
      const state = client.getQueryState(refKey(ref));
      return (
        !state?.dataUpdatedAt || Date.now() - state.dataUpdatedAt > STALE_MS
      );
    });
    const out: PrincipalRef[][] = [];
    for (let i = 0; i < missing.length; i += BATCH) {
      out.push(missing.slice(i, i + BATCH));
    }
    return out;
    // `refs` is represented by `signature`.
  }, [signature, client]);

  const results = useQueries({
    queries: chunks.map((chunk) => ({
      queryKey: ["principals", "lookup", chunk.map(textKey).sort()],
      staleTime: STALE_MS,
      // Labels sharing a failed lookup must not each start it again.
      retryOnMount: false,
      queryFn: async () => {
        const found = await lookupPrincipals(chunk);
        for (const principal of found) {
          client.setQueryData(refKey(principal), principal);
        }
        return found;
      },
    })),
  });

  const unavailable = results.some(
    (r) => (r.error as ApiError | null)?.code === "tereo_unreachable"
  );

  return {
    get: (ref: PrincipalRef) =>
      client.getQueryData<Principal>(refKey(ref)) ??
      results
        .flatMap((r) => r.data ?? [])
        .find((p) => p.type === ref.type && p.id === ref.id),
    unavailable,
  };
};
