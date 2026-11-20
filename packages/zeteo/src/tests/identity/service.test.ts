// @module-tag int
// @module-tag platform
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { initializeTereo, stopTereo } from "../../utils/tereo.js";
import { prisma } from "../../utils/db/prisma.js";
import { randomUUID } from "crypto";
import {
  addValues,
  createKey,
  keysById,
  keysByName,
  removeKey,
  valuesOfUser,
} from "../../identity/service.js";

describe("identity service", () => {
  const actor = randomUUID();
  const keyIds: string[] = [];
  const prefix = `s${randomUUID().slice(0, 8).replace(/-/g, "")}`;

  beforeAll(initializeTereo);
  afterAll(async () => {
    await prisma.identityValue.deleteMany({ where: { keyId: { in: keyIds } } });
    await prisma.$executeRaw`
      DELETE FROM "core"."core_outbox" WHERE payload->>'entityId' = ANY(${keyIds}::text[])`;
    await prisma.identityKey.deleteMany({ where: { id: { in: keyIds } } });
    await stopTereo();
  });

  it("looks keys up by name and id and reads a user's values per key", async () => {
    const a = await createKey({ name: `${prefix}_a`, label: "A" }, actor);
    const b = await createKey({ name: `${prefix}_b`, label: "B" }, actor);
    keyIds.push(a.id, b.id);
    const user = randomUUID();
    await addValues(
      a.id,
      [
        { userId: user, value: "1" },
        { userId: user, value: "2" },
        { userId: randomUUID(), value: "3" },
      ],
      actor
    );
    expect([...(await keysByName([a.name, "nope_zz"])).keys()]).toEqual([
      a.name,
    ]);
    expect([...(await keysById([a.id, b.id])).keys()].sort()).toEqual(
      [a.id, b.id].sort()
    );
    const values = await valuesOfUser(user, [a.id, b.id]);
    expect(values.get(a.id)).toEqual(["1", "2"]);
    expect(values.has(b.id)).toBe(false);
    expect((await valuesOfUser(user, [])).size).toBe(0);
  });

  it("removes a key together with its values", async () => {
    const k = await createKey({ name: `${prefix}_c`, label: "C" }, actor);
    keyIds.push(k.id);
    await addValues(k.id, [{ userId: randomUUID(), value: "x" }], actor);
    await removeKey(k.id, actor);
    expect(await prisma.identityValue.count({ where: { keyId: k.id } })).toBe(
      0
    );
    expect(await prisma.identityKey.count({ where: { id: k.id } })).toBe(0);
  });
});
