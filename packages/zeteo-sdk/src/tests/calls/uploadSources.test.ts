import { useStubbedClient } from "../support/callContext.js";
import type { Source } from "../../types/sources.js";
import { describe, expect, it } from "vitest";

const ID = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";

const source: Source = {
  id: ID,
  slug: "people",
  name: "People",
  type: "upload",
  owner_id: USER,
  settings: null,
  schemas: ["zu_11111111111141118111111111111111"],
  timeout_ms: 30000,
  row_cap: 50000,
  max_joins: 4,
  export_enabled: false,
  export_row_cap: 0,
  query_concurrency: 5,
  export_concurrency: 2,
  writable_login_allowed: false,
  status: "active",
  last_refreshed_at: null,
  size_bytes: 10,
  size_measured_at: null,
  share_count: 0,
  created_at: "2026-11-17T10:00:00.000Z",
  archived_at: null,
};

describe("upload sources", () => {
  const t = useStubbedClient();

  it("sources.list sends the owner and type filters", async () => {
    t.stub.respond(() => ({ body: { data: [source], next_cursor: null } }));
    const out = await t.client.sources.list({ owner_id: "me", type: "upload" });
    expect(out.data).toEqual([source]);
    expect(t.stub.requests.at(-1)).toMatchObject({
      method: "GET",
      path: "/v1/sources",
    });
    expect(t.stub.requests.at(-1)?.query).toMatchObject({
      owner_id: "me",
      type: "upload",
    });
  });

  it("sources.create sends an upload source's body to POST /v1/sources", async () => {
    t.stub.respond(() => ({ status: 201, body: source }));
    const body = {
      type: "upload" as const,
      staging_id: USER,
      name: "People",
      tables: [{ key: "csv" }],
    };
    expect(await t.client.sources.create(body)).toEqual(source);
    expect(t.stub.requests.at(-1)).toMatchObject({
      method: "POST",
      path: "/v1/sources",
      body,
    });
  });

  it("uploads.create sends multipart to /v1/uploads", async () => {
    t.stub.respond(() => ({
      status: 201,
      body: { staging_id: ID, expires_at: "x", tables: [] },
    }));
    const out = await t.client.uploads.create(
      new Blob(["a,b\n1,2\n"]),
      "a.csv"
    );
    expect(out.staging_id).toBe(ID);
    const req = t.stub.requests.at(-1)!;
    expect(req).toMatchObject({ method: "POST", path: "/v1/uploads" });
    expect(String(req.headers["content-type"])).toContain(
      "multipart/form-data"
    );
    expect(JSON.stringify(req.body)).toContain("a.csv");
  });

  it("uploads.discard, sources.delete and sources.removeTable answer 204", async () => {
    t.stub.respond(() => ({ status: 204 }));
    await expect(t.client.uploads.discard(ID)).resolves.toBeUndefined();
    expect(t.stub.requests.at(-1)).toMatchObject({
      method: "DELETE",
      path: `/v1/uploads/${ID}`,
    });
    await expect(t.client.sources.delete(ID)).resolves.toBeUndefined();
    expect(t.stub.requests.at(-1)).toMatchObject({
      method: "DELETE",
      path: `/v1/sources/${ID}`,
    });
    await expect(
      t.client.sources.removeTable(ID, USER)
    ).resolves.toBeUndefined();
    expect(t.stub.requests.at(-1)).toMatchObject({
      method: "DELETE",
      path: `/v1/sources/${ID}/tables/${USER}`,
    });
  });
});
