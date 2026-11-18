// @module-tag int
// @module-tag platform
import { initializeTereo, stopTereo } from "../../../../utils/tereo.js";
import { DATA_READ } from "../../../../definitions/tereoDeclaration.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fetchJson, BASE_URL } from "../../../support/http.js";
import { writeToken } from "../../../support/sources.js";
import { tokenFor } from "../../../support/tokens.js";
import { randomUUID } from "crypto";
import {
  removeUploadSources,
  seedUploadSource,
  type UploadTableSpec,
} from "../../../support/fileSources.js";
import {
  grantTo,
  newQueryUser,
  postQuery,
  removeRunsOf,
  type SeededSource,
} from "../../../support/queries.js";

const CUSTOMERS: UploadTableSpec = {
  name: "customers",
  columns: [
    { name: "id", type: "number" },
    { name: "name", type: "text" },
    { name: "region", type: "text" },
  ],
  rows: [
    ["1", "Acme", "north"],
    ["2", "Globex", "south"],
    ["3", "Initech", ""],
  ],
};

const ORDERS: UploadTableSpec = {
  name: "orders",
  columns: [
    { name: "id", type: "number" },
    { name: "customer_id", type: "number" },
    { name: "total", type: "number" },
    { name: "paid", type: "boolean" },
    { name: "day", type: "date" },
    { name: "at", type: "timestamp" },
  ],
  rows: [
    ["1", "1", "10.50", "true", "2026-01-02", "2026-01-02T10:00:00Z"],
    ["2", "1", "20", "FALSE", "2026-01-03", "2026-01-03T11:30:00Z"],
    ["3", "2", "5", "true", "2026-02-01", ""],
    ["4", "3", "", "", "", ""],
  ],
};

describe("POST /v1/query: file sources", () => {
  const ownerId = randomUUID();
  const ownerToken = tokenFor({ userId: ownerId, permissions: [DATA_READ] });
  let source: SeededSource;
  let capped: SeededSource;
  const users: string[] = [ownerId];

  beforeAll(async () => {
    source = await seedUploadSource({ ownerId, tables: [CUSTOMERS, ORDERS] });
    capped = await seedUploadSource({
      ownerId,
      tables: [ORDERS],
      fields: { rowCap: 2 },
    });
    await initializeTereo();
    const res = await fetchJson(
      "POST",
      `${BASE_URL}/v1/sources/${source.id}/relations`,
      writeToken(),
      {
        name: "customer",
        from_table_id: source.tables.orders!.id,
        from_columns: ["customer_id"],
        to_table_id: source.tables.customers!.id,
        to_columns: ["id"],
        to_many: false,
      }
    );
    if (res.status !== 201) {
      throw new Error(
        `relation not declared: ${res.status} ${res.body?.error}`
      );
    }
  });
  afterAll(async () => {
    await stopTereo();
    await removeRunsOf(users);
    await removeUploadSources([source.id, capped.id]);
  });

  it("returns a granted user's rows, each type in its wire form", async () => {
    const user = newQueryUser();
    users.push(user.id);
    await grantTo(user.principal, source.tables.orders!, "all");
    const res = await postQuery(user.token, {
      source: source.slug,
      from: "orders",
      select: ["id", "total", "paid", "day", "at"],
      orderBy: [{ id: "asc" }],
    });
    expect(res.status).toBe(200);
    expect(res.body.columns).toEqual([
      { name: "id", type: "number" },
      { name: "total", type: "number" },
      { name: "paid", type: "boolean" },
      { name: "day", type: "date" },
      { name: "at", type: "timestamp" },
    ]);
    expect(res.body.rows).toEqual([
      ["1", "10.50", true, "2026-01-02", "2026-01-02T10:00:00.000Z"],
      ["2", "20", false, "2026-01-03", "2026-01-03T11:30:00.000Z"],
      ["3", "5", true, "2026-02-01", null],
      ["4", null, null, null, null],
    ]);
  });

  it("lets the owner query through the owner grant", async () => {
    const res = await postQuery(ownerToken, {
      source: source.slug,
      from: "customers",
      select: ["name"],
      where: { region: { isNull: true } },
    });
    expect(res.status).toBe(200);
    expect(res.body.rows).toEqual([["Initech"]]);
  });

  it("joins two tables through a declared relation", async () => {
    const res = await postQuery(ownerToken, {
      source: source.slug,
      from: "orders",
      join: ["customer"],
      select: ["customer.name", { count: "*", as: "orders" }],
      groupBy: ["customer.name"],
      orderBy: [{ orders: "desc" }, { "customer.name": "asc" }],
    });
    expect(res.status).toBe(200);
    expect(res.body.rows).toEqual([
      ["Acme", "2"],
      ["Globex", "1"],
      ["Initech", "1"],
    ]);
  });

  it("answers 422 not_found_or_not_accessible for a table not granted", async () => {
    const user = newQueryUser();
    users.push(user.id);
    await grantTo(user.principal, source.tables.orders!, "all");
    const res = await postQuery(user.token, {
      source: source.slug,
      from: "customers",
      select: ["name"],
    });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe("not_found_or_not_accessible");
  });

  it("holds a query to the source's row cap", async () => {
    const res = await postQuery(ownerToken, {
      source: capped.slug,
      from: "orders",
      select: ["id"],
      orderBy: [{ id: "asc" }],
    });
    expect(res.status).toBe(200);
    expect(res.body.rows).toEqual([["1"], ["2"]]);
    expect(res.body.truncated).toBe(true);
    expect(res.body.truncated_by).toBe("rows");
  });
});
