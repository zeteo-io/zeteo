import type {
  IdentityKey,
  IdentityValue,
} from "../../prisma/generated/client/index.js";

export const identityKeyView = (row: IdentityKey, valueCount: number) => ({
  id: row.id,
  name: row.name,
  label: row.label,
  description: row.description,
  value_count: valueCount,
  created_by: row.createdBy,
  created_at: row.createdAt.toISOString(),
  updated_at: row.updatedAt.toISOString(),
});

/** What a holder of `zeteo.uploads.write` alone sees: enough to name a key, no ids or counts. */
export const identityKeyNameView = (row: IdentityKey) => ({
  name: row.name,
  label: row.label,
  description: row.description,
});

export const identityValueView = (row: IdentityValue) => ({
  id: row.id,
  key_id: row.keyId,
  user_id: row.userId,
  value: row.value,
  created_by: row.createdBy,
  created_at: row.createdAt.toISOString(),
});
