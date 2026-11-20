// @module-tag int
// @module-tag platform
// @module-tag race
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { removeSources } from "../../../support/sources.js";
import { startV1Routes } from "../../../support/v1App.js";
import { prisma } from "../../../../utils/db/prisma.js";
import { fetchJson } from "../../../support/http.js";
import { randomUUID } from "crypto";
import {
  columnsOf,
  grantsWriteToken,
  registerSource,
  tableOf,
} from "../../../support/grants.js";

describe("PUT /v1/grants/:id", () => {
  let app: Awaited<ReturnType<typeof startV1Routes>>;
  let sourceId: string;
  let columnIds: string[];
  let tableId: string;

  const call = (method: string, path: string, body?: unknown) =>
    fetchJson(method, `${app.url}/v1/grants${path}`, grantsWriteToken(), body);

  beforeAll(async () => {
    app = await startV1Routes();
    sourceId = await registerSource(app.url);
    const orders = await tableOf(sourceId, "orders");
    tableId = orders.id;
    columnIds = (await columnsOf(orders.id)).map((c) => c.id);
  });
  afterAll(async () => {
    await removeSources([sourceId]);
    await app.close();
  });

  it("answers 200 to concurrent replaces with overlapping columns and ends in one of them", async () => {
    expect(columnIds.length).toBeGreaterThanOrEqual(3);
    const lists = [
      columnIds.slice(0, 2),
      columnIds.slice(1, 3),
      columnIds.slice(0, 3),
      columnIds.slice(0, 1),
    ];
    for (let round = 0; round < 5; round++) {
      const made = await call("POST", "", {
        principal_type: "user",
        principal_id: randomUUID(),
        table_id: tableId,
        all_columns: false,
        column_ids: columnIds.slice(0, 2),
      });
      expect(made.status).toBe(201);

      const answers = await Promise.all(
        lists.map((column_ids) =>
          call("PUT", `/${made.body.id}`, {
            row_access: "unlimited_default",
            all_columns: false,
            column_ids,
          })
        )
      );
      expect(answers.map((a) => a.status)).toEqual(lists.map(() => 200));

      const final = (
        await prisma.grantColumn.findMany({ where: { grantId: made.body.id } })
      )
        .map((c) => c.columnId)
        .sort();
      expect(lists.map((l) => [...l].sort())).toContainEqual(final);
    }
  });
});

describe("DELETE /v1/grants/:id", () => {
  let app: Awaited<ReturnType<typeof startV1Routes>>;
  let sourceId: string;
  let tableId: string;

  const call = (method: string, path: string, body?: unknown) =>
    fetchJson(method, `${app.url}/v1/grants${path}`, grantsWriteToken(), body);

  beforeAll(async () => {
    app = await startV1Routes();
    sourceId = await registerSource(app.url);
    tableId = (await tableOf(sourceId, "orders")).id;
  });
  afterAll(async () => {
    await removeSources([sourceId]);
    await app.close();
  });

  it("answers one 204 and 404 to the rest when one grant is removed at once by several", async () => {
    for (let round = 0; round < 5; round++) {
      const made = await call("POST", "", {
        principal_type: "user",
        principal_id: randomUUID(),
        table_id: tableId,
        all_columns: true,
      });
      expect(made.status).toBe(201);

      const answers = await Promise.all(
        [1, 2, 3, 4].map(() => call("DELETE", `/${made.body.id}`))
      );
      const statuses = answers.map((a) => a.status).sort();
      expect(statuses).toEqual([204, 404, 404, 404]);
      for (const answer of answers.filter((a) => a.status === 404)) {
        expect(answer.body).toMatchObject({
          error: "not_found",
          error_description: "Grant not found",
        });
      }
    }
  });

  it("refuses a removal that waited on a change flagging the grant as an owner grant", async () => {
    const made = await call("POST", "", {
      principal_type: "user",
      principal_id: randomUUID(),
      table_id: tableId,
      all_columns: true,
    });
    expect(made.status).toBe(201);
    const id = made.body.id as string;

    // A transfer's change, held open: the row locked and flagged, uncommitted.
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    let flagged!: () => void;
    const isFlagged = new Promise<void>((resolve) => (flagged = resolve));
    const holder = prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "zeteo"."grants" WHERE "id" = ${id}::uuid FOR UPDATE`;
        await tx.grant.update({ where: { id }, data: { ownerGrant: true } });
        flagged();
        await released;
      },
      { timeout: 20_000 }
    );
    await isFlagged;

    const removal = call("DELETE", `/${id}`);
    // Until the removal waits on the held row lock.
    for (let i = 0; i < 200; i++) {
      const waiting = await prisma.$queryRaw<Array<{ n: number }>>`
        SELECT 1 AS n FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock'
          AND query ILIKE '%grants%'`;
      if (waiting.length > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    release();
    await holder;

    const res = await removal;
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("owner_grant_locked");
    expect(await prisma.grant.findUnique({ where: { id } })).not.toBeNull();
  });
});
