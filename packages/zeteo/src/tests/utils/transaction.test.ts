// @module-tag int
// @module-tag platform
import { AUDIT_EVENTS } from "../../definitions/tereoDeclaration.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { initializeTereo, stopTereo } from "../../utils/tereo.js";
import { withAudit } from "../../utils/transaction.js";
import { prisma } from "../../utils/db/prisma.js";
import { randomUUID } from "crypto";

const resourceId = () => randomUUID();

const outboxRows = (id: string) =>
  prisma.$queryRaw<
    Array<{ destination: string; payload: Record<string, unknown> }>
  >`SELECT destination, payload FROM "core"."core_outbox" WHERE payload->>'entityId' = ${id}`;

const probeRows = async (id: string) =>
  Number(
    (
      await prisma.$queryRaw<Array<{ n: bigint }>>`
        SELECT count(*) AS n FROM "zeteo"."transaction_probe" WHERE id = ${id}`
    )[0].n
  );

describe("withAudit", () => {
  const created: string[] = [];

  beforeAll(async () => {
    await initializeTereo();
    await prisma.$executeRaw`CREATE TABLE IF NOT EXISTS "zeteo"."transaction_probe" (id text PRIMARY KEY)`;
  });
  afterAll(async () => {
    for (const id of created) {
      await prisma.$executeRaw`DELETE FROM "core"."core_outbox" WHERE payload->>'entityId' = ${id}`;
    }
    await prisma.$executeRaw`DROP TABLE IF EXISTS "zeteo"."transaction_probe"`;
    await stopTereo();
  });

  it("writes the recorded entry to core.outbox when the transaction commits", async () => {
    const id = resourceId();
    created.push(id);
    const actorId = randomUUID();

    const result = await withAudit(async (tx, audit) => {
      await tx.$executeRaw`INSERT INTO "zeteo"."transaction_probe" (id) VALUES (${id})`;
      audit({
        action: AUDIT_EVENTS.sourceCreated,
        resourceType: "Source",
        resourceId: id,
        actorId,
        metadata: { name: "warehouse" },
      });
      return "done";
    });

    expect(result).toBe("done");
    expect(await probeRows(id)).toBe(1);
    const rows = await outboxRows(id);
    expect(rows).toHaveLength(1);
    expect(rows[0].destination).toBe("audit");
    expect(rows[0].payload).toMatchObject({
      userId: actorId,
      action: "CREATE",
      entityType: "Source",
      entityId: id,
      metadata: { name: "warehouse", event: AUDIT_EVENTS.sourceCreated },
    });
  });

  it("keeps the entries in the order they were recorded", async () => {
    const id = resourceId();
    created.push(id);
    const actorId = randomUUID();

    await withAudit(async (_tx, audit) => {
      for (const action of [
        AUDIT_EVENTS.sourceCreated,
        AUDIT_EVENTS.sourceUpdated,
        AUDIT_EVENTS.sourceArchived,
      ]) {
        audit({ action, resourceType: "Source", resourceId: id, actorId });
      }
    });

    const rows = await prisma.$queryRaw<Array<{ action: string }>>`
      SELECT payload->>'action' AS action FROM "core"."core_outbox"
      WHERE payload->>'entityId' = ${id} ORDER BY created_at, id`;
    expect(rows.map((r) => r.action)).toEqual(["CREATE", "UPDATE", "ARCHIVE"]);
  });

  it("leaves neither the row change nor the outbox row when fn throws", async () => {
    const id = resourceId();
    created.push(id);

    await expect(
      withAudit(async (tx, audit) => {
        await tx.$executeRaw`INSERT INTO "zeteo"."transaction_probe" (id) VALUES (${id})`;
        audit({
          action: AUDIT_EVENTS.sourceCreated,
          resourceType: "Source",
          resourceId: id,
          actorId: randomUUID(),
        });
        throw new Error("boom");
      })
    ).rejects.toThrow("boom");

    expect(await probeRows(id)).toBe(0);
    expect(await outboxRows(id)).toHaveLength(0);
  });

  it("rolls back the row change when an entry is invalid", async () => {
    const id = resourceId();
    created.push(id);

    await expect(
      withAudit(async (tx, audit) => {
        await tx.$executeRaw`INSERT INTO "zeteo"."transaction_probe" (id) VALUES (${id})`;
        audit({
          action: AUDIT_EVENTS.sourceCreated,
          resourceType: "Source",
          resourceId: id,
          actorId: "not-a-uuid",
        });
      })
    ).rejects.toThrow(/userId/);

    expect(await probeRows(id)).toBe(0);
  });

  it("refuses a call to tereo made inside the transaction", async () => {
    const { getTereo } = await import("../../utils/tereo.js");
    await expect(
      withAudit(async () => {
        await getTereo().auth.introspectToken("x");
      })
    ).rejects.toThrow(/inside a withAudit transaction/);
  });
});
