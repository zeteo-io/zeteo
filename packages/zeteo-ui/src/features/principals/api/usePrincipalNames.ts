import { api, toApiError, type ApiError } from "@/lib/api";
import { useQueries } from "@tanstack/react-query";

export type PrincipalRef = { type: "user" | "group"; id: string };

export interface Principal extends PrincipalRef {
  name: string | null;
  email?: string | null;
  status: "active" | "inactive" | "orphaned";
}

const BATCH = 100;
const STALE_MS = 60_000;
const BATCH_WINDOW_MS = 10;

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

interface Waiter {
  ref: PrincipalRef;
  resolve: (principal: Principal) => void;
  reject: (error: ApiError) => void;
}

// Every ref asked for within one window, by any component, goes out together:
// a list of labels renders each with its own hook, yet makes one request per
// 100 distinct principals.
let waiting = new Map<string, Waiter[]>();
let timer: ReturnType<typeof setTimeout> | undefined;

const flush = () => {
  timer = undefined;
  const batch = waiting;
  waiting = new Map();
  const keys = [...batch.keys()];
  for (let i = 0; i < keys.length; i += BATCH) {
    const chunk = keys.slice(i, i + BATCH);
    const refs = chunk.map((key) => batch.get(key)![0].ref);
    lookupPrincipals(refs).then(
      (found) => {
        const byKey = new Map(found.map((p) => [textKey(p), p]));
        for (const key of chunk) {
          const principal = byKey.get(key);
          for (const waiter of batch.get(key)!) {
            if (principal) waiter.resolve(principal);
            else {
              waiter.reject({
                status: 502,
                code: "lookup_incomplete",
                message: "The lookup did not answer for this id",
              });
            }
          }
        }
      },
      (error: ApiError) => {
        for (const key of chunk) {
          for (const waiter of batch.get(key)!) waiter.reject(error);
        }
      }
    );
  }
};

const requestPrincipal = (ref: PrincipalRef): Promise<Principal> =>
  new Promise((resolve, reject) => {
    const key = textKey(ref);
    const list = waiting.get(key) ?? [];
    list.push({ ref, resolve, reject });
    waiting.set(key, list);
    timer ??= setTimeout(flush, BATCH_WINDOW_MS);
  });

// Tereo did not answer (or the answer could not be had): the id can still be
// used, only its name is missing.
export const isUnavailable = (error: ApiError | null): boolean =>
  error !== null &&
  error.code !== "cancelled" &&
  (error.status === null || error.status >= 500);

/**
 * Names for principals. Each ref is its own query, kept 60 s, so a ref already
 * known or in flight is never asked for again; the requests of all callers are
 * merged by `requestPrincipal`.
 */
export const usePrincipalNames = (refs: PrincipalRef[]) => {
  const distinct = [...new Map(refs.map((r) => [textKey(r), r])).values()];
  const results = useQueries({
    queries: distinct.map((ref) => ({
      queryKey: refKey(ref),
      staleTime: STALE_MS,
      // Labels sharing a failed lookup must not each start it again.
      retryOnMount: false,
      queryFn: () => requestPrincipal(ref),
    })),
  });

  const byKey = new Map(distinct.map((ref, i) => [textKey(ref), results[i]]));
  const errors = results
    .map((r) => (r.error as ApiError | null) ?? null)
    .filter((e): e is ApiError => e !== null);

  return {
    get: (ref: PrincipalRef): Principal | undefined =>
      byKey.get(textKey(ref))?.data,
    unavailable: errors.some(isUnavailable),
    error: errors[0] ?? null,
  };
};
