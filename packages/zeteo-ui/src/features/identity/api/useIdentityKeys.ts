import type { IdentityKey } from "./types";
import { useCursorList } from "@/lib/api";

/** The identity keys a row rule can name (a key maps a person to values of a column). */
export const useIdentityKeys = (enabled = true) => {
  const list = useCursorList<IdentityKey>(
    ["identity-keys"],
    "/v1/identity-keys",
    {},
    { enabled }
  );
  return {
    keys: list.items,
    isLoading: list.isLoading,
    error: list.error,
  };
};
