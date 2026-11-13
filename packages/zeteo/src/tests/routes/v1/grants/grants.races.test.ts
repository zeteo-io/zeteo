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
          call("PUT", `/${made.body.id}`, { all_columns: false, column_ids })
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
