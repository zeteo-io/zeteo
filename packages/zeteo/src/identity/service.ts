import { AUDIT_EVENTS } from "../definitions/tereoDeclaration.js";
import { withAudit } from "../utils/transaction.js";
import { prisma } from "../utils/db/prisma.js";
import type {
  IdentityKey,
  IdentityValue,
} from "../../prisma/generated/client/index.js";
import {
  ConflictError,
  IdentityKeyInUseError,
  IdentityValueTakenError,
  NotFoundError,
} from "../utils/errors.js";

const KEY_TYPE = "identity_key";
const keyNotFound = () => new NotFoundError("Identity key not found");
const valueNotFound = () => new NotFoundError("Identity value not found");

export interface NewIdentityValue {
  userId: string;
  value: string;
}

/** Keys by name, in the order the database returns them; unknown names are absent. */
export const keysByName = async (
  names: string[]
): Promise<Map<string, IdentityKey>> => {
  const rows = await prisma.identityKey.findMany({
    where: { name: { in: names } },
  });
  return new Map(rows.map((row) => [row.name, row]));
};

export const keysById = async (
  ids: string[]
): Promise<Map<string, IdentityKey>> => {
  const rows = await prisma.identityKey.findMany({
    where: { id: { in: ids } },
  });
  return new Map(rows.map((row) => [row.id, row]));
};

/** What a user holds for each of the keys: key id to values (a key with none maps to nothing). */
export const valuesOfUser = async (
  userId: string,
  keyIds: string[]
): Promise<Map<string, string[]>> => {
  const out = new Map<string, string[]>();
  if (keyIds.length === 0) return out;
  const rows = await prisma.identityValue.findMany({
    where: { userId, keyId: { in: keyIds } },
    orderBy: { id: "asc" },
    select: { keyId: true, value: true },
  });
  for (const row of rows) {
    out.set(row.keyId, [...(out.get(row.keyId) ?? []), row.value]);
  }
  return out;
};

export const listKeys = async (): Promise<
  Array<IdentityKey & { valueCount: number }>
> => {
  const [keys, counts] = await Promise.all([
    prisma.identityKey.findMany({ orderBy: { name: "asc" } }),
    prisma.identityValue.groupBy({ by: ["keyId"], _count: { _all: true } }),
  ]);
  const byKey = new Map(counts.map((c) => [c.keyId, c._count._all]));
  return keys.map((key) => ({ ...key, valueCount: byKey.get(key.id) ?? 0 }));
};

export const createKey = async (
  input: { name: string; label: string; description?: string },
  actorId: string
): Promise<IdentityKey> =>
  withAudit(async (tx, audit) => {
    const taken = await tx.identityKey.findUnique({
      where: { name: input.name },
      select: { id: true },
    });
    if (taken) {
      throw new ConflictError("An identity key with this name exists");
    }
    const created = await tx.identityKey.create({
      data: {
        name: input.name,
        label: input.label,
        description: input.description ?? null,
        createdBy: actorId,
      },
    });
    audit({
      action: AUDIT_EVENTS.identityKeyCreated,
      resourceType: KEY_TYPE,
      resourceId: created.id,
      actorId,
      metadata: { name: created.name, label: created.label },
    });
    return created;
  });

export const updateKey = async (
  id: string,
  input: { label?: string; description?: string | null },
  actorId: string
): Promise<IdentityKey> =>
  withAudit(async (tx, audit) => {
    const before = await tx.identityKey.findUnique({ where: { id } });
    if (!before) throw keyNotFound();
    const updated = await tx.identityKey.update({
      where: { id },
      data: {
        ...(input.label !== undefined ? { label: input.label } : {}),
        ...(input.description !== undefined
          ? { description: input.description }
          : {}),
      },
    });
    audit({
      action: AUDIT_EVENTS.identityKeyUpdated,
      resourceType: KEY_TYPE,
      resourceId: id,
      actorId,
      metadata: {
        name: updated.name,
        label: updated.label,
        previous_label: before.label,
      },
    });
    return updated;
  });

/** Locks the key's row so changes to its values and its removal take turns. */
const lockKey = async (
  tx: Parameters<Parameters<typeof withAudit>[0]>[0],
  id: string
) => {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "zeteo"."identity_keys" WHERE "id" = ${id}::uuid FOR UPDATE`;
  if (rows.length === 0) throw keyNotFound();
};

/** Removes the key and its values; refused while a grant lists it. */
export const removeKey = async (id: string, actorId: string): Promise<void> => {
  await withAudit(async (tx, audit) => {
    await lockKey(tx, id);
    const key = await tx.identityKey.findUniqueOrThrow({ where: { id } });
    const grants = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "zeteo"."grants"
      WHERE ${id}::uuid = ANY(COALESCE("identity_key_ids", '{}'::uuid[]))
      ORDER BY "id"`;
    if (grants.length > 0) {
      throw new IdentityKeyInUseError(grants.map((g) => g.id));
    }
    const { count } = await tx.identityValue.deleteMany({
      where: { keyId: id },
    });
    await tx.identityKey.delete({ where: { id } });
    audit({
      action: AUDIT_EVENTS.identityKeyRemoved,
      resourceType: KEY_TYPE,
      resourceId: id,
      actorId,
      metadata: { name: key.name, label: key.label, values_removed: count },
    });
  });
};

export const listValues = async (input: {
  keyId: string;
  userId?: string;
  cursor?: string;
  limit: number;
}): Promise<{ rows: IdentityValue[]; hasMore: boolean }> => {
  const key = await prisma.identityKey.findUnique({
    where: { id: input.keyId },
    select: { id: true },
  });
  if (!key) throw keyNotFound();
  const rows = await prisma.identityValue.findMany({
    where: {
      keyId: input.keyId,
      ...(input.userId ? { userId: input.userId } : {}),
      ...(input.cursor ? { id: { gt: input.cursor } } : {}),
    },
    orderBy: { id: "asc" },
    take: input.limit + 1,
  });
  return {
    rows: rows.slice(0, input.limit),
    hasMore: rows.length > input.limit,
  };
};

/**
 * Adds the values, all or nothing. A value a user already holds is kept as
 * it is; one held by another user (or given to two users in the call) fails
 * the call as `identity_value_taken`.
 */
export const addValues = async (
  keyId: string,
  values: NewIdentityValue[],
  actorId: string
): Promise<IdentityValue[]> =>
  withAudit(async (tx, audit) => {
    await lockKey(tx, keyId);
    const wanted = new Map<string, string>();
    for (const { userId, value } of values) {
      const holder = wanted.get(value);
      if (holder !== undefined && holder !== userId) {
        throw new IdentityValueTakenError(value);
      }
      wanted.set(value, userId);
    }
    const existing = await tx.identityValue.findMany({
      where: { keyId, value: { in: [...wanted.keys()] } },
    });
    const held = new Map(existing.map((row) => [row.value, row]));
    for (const [value, userId] of wanted) {
      const row = held.get(value);
      if (row && row.userId !== userId)
        throw new IdentityValueTakenError(value);
    }
    const fresh = [...wanted].filter(([value]) => !held.has(value));
    const created: IdentityValue[] = [];
    for (const [value, userId] of fresh) {
      created.push(
        await tx.identityValue.create({
          data: { keyId, userId, value, createdBy: actorId },
        })
      );
    }
    const key = await tx.identityKey.findUniqueOrThrow({
      where: { id: keyId },
    });
    audit({
      action: AUDIT_EVENTS.identityValuesAdded,
      resourceType: KEY_TYPE,
      resourceId: keyId,
      actorId,
      // Counts and users only: the values themselves stay out of the log.
      metadata: {
        name: key.name,
        user_ids: [...new Set(created.map((row) => row.userId))],
        count: created.length,
      },
    });
    return [...held.values()]
      .filter((row) => wanted.get(row.value) === row.userId)
      .concat(created);
  });

export const removeValue = async (
  keyId: string,
  valueId: string,
  actorId: string
): Promise<void> => {
  await withAudit(async (tx, audit) => {
    await lockKey(tx, keyId);
    const row = await tx.identityValue.findFirst({
      where: { id: valueId, keyId },
    });
    if (!row) throw valueNotFound();
    await tx.identityValue.delete({ where: { id: valueId } });
    audit({
      action: AUDIT_EVENTS.identityValueRemoved,
      resourceType: KEY_TYPE,
      resourceId: keyId,
      actorId,
      metadata: { value_id: valueId, user_id: row.userId },
    });
  });
};
