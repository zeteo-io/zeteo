import { useStubbedClient } from "../support/callContext.js";
import type { FileSource } from "../../types/fileSources.js";
import { describe, expect, it } from "vitest";

const ID = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";

const source: FileSource = {
  id: ID,
  slug: "people",
  name: "People",
  type: "upload",
  owner_id: USER,
  created_at: "2026-11-17T10:00:00.000Z",
  archived_at: null,
  stored_bytes: 10,
  share_count: 0,
  tables: [],
};

describe("fileSources", () => {
  const t = useStubbedClient();

  it("list sends GET /v1/file-sources with its scope", async () => {
    t.stub.respond(() => ({ body: { data: [source] } }));
    const out = await t.client.fileSources.list({ scope: "all" });
    expect(out.data).toEqual([source]);
    expect(t.stub.requests.at(-1)).toMatchObject({
      method: "GET",
      path: "/v1/file-sources",
    });
    expect(t.stub.requests.at(-1)?.query).toMatchObject({ scope: "all" });
  });

  it("get answers null on 404", async () => {
    t.stub.respond(() => ({ status: 404, body: { error: "not_found" } }));
    expect(await t.client.fileSources.get(ID)).toBeNull();
  });

  it("upload sends multipart to /v1/file-sources/uploads", async () => {
    t.stub.respond(() => ({
      status: 201,
      body: { staging_id: ID, expires_at: "x", tables: [] },
    }));
    const out = await t.client.fileSources.upload(
      new Blob(["a,b\n1,2\n"]),
      "a.csv"
    );
    expect(out.staging_id).toBe(ID);
    const req = t.stub.requests.at(-1)!;
    expect(req).toMatchObject({
      method: "POST",
      path: "/v1/file-sources/uploads",
    });
    expect(String(req.headers["content-type"])).toContain(
      "multipart/form-data"
    );
    expect(JSON.stringify(req.body)).toContain("a.csv");
  });

  it("delete and table delete answer 204", async () => {
    t.stub.respond(() => ({ status: 204 }));
    await expect(t.client.fileSources.delete(ID)).resolves.toBeUndefined();
    await expect(
      t.client.fileSources.tables.delete(ID, USER)
    ).resolves.toBeUndefined();
  });
});
