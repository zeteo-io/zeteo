import { send, type CallContext } from "../send.js";
import type { Page } from "../types/common.js";
import type {
  CreateIdentityKeyRequest,
  IdentityKey,
  IdentityKeyName,
  IdentityValue,
  ListIdentityValuesOptions,
  MissingIdentityValues,
  NewIdentityValue,
  AddIdentityValuesResult,
  UpdateIdentityKeyRequest,
} from "../types/grants.js";

export const identityKeysCalls = (ctx: CallContext) => ({
  /**
   * Every key in one page (`next_cursor` is null). A caller with only
   * `zeteo.uploads.write` gets `IdentityKeyName`s: no ids, counts or values.
   */
  list: (): Promise<Page<IdentityKey | IdentityKeyName>> =>
    send(ctx, { op: "listIdentityKeys" }),
  /** A name already in use is a 409 `conflict`. */
  create: (body: CreateIdentityKeyRequest): Promise<IdentityKey> =>
    send(ctx, { op: "createIdentityKey", body, once: true }),
  update: (
    keyId: string,
    body: UpdateIdentityKeyRequest
  ): Promise<IdentityKey> =>
    send(ctx, {
      op: "updateIdentityKey",
      params: { keyId },
      body,
      once: true,
    }),
  /** Refused with `identity_key_in_use` (409, `grant_ids`) while a grant's rule names the key. */
  delete: async (keyId: string): Promise<void> => {
    await send(ctx, {
      op: "deleteIdentityKey",
      params: { keyId },
      once: false,
    });
  },
  values: {
    list: (
      keyId: string,
      options?: ListIdentityValuesOptions
    ): Promise<Page<IdentityValue>> =>
      send(ctx, {
        op: "listIdentityValues",
        params: { keyId },
        query: { ...options },
      }),
    /**
     * Up to 1,000 pairs, all or none; a value another user holds is
     * `identity_value_taken` (409, `value`). `warnings` names new values close
     * to another user's (`near_duplicate`).
     */
    add: (
      keyId: string,
      values: NewIdentityValue[]
    ): Promise<AddIdentityValuesResult> =>
      send(ctx, {
        op: "addIdentityValues",
        params: { keyId },
        body: { values },
        once: true,
      }),
    delete: async (keyId: string, valueId: string): Promise<void> => {
      await send(ctx, {
        op: "deleteIdentityValue",
        params: { keyId, valueId },
        once: false,
      });
    },
  },
  /** Users a rule using the key reaches who hold no value under it. */
  missing: (keyId: string): Promise<MissingIdentityValues> =>
    send(ctx, { op: "listMissingIdentityValues", params: { keyId } }),
});
