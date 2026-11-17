import { useStubbedClient } from "../support/callContext.js";
import { describe, expect, it } from "vitest";

const me = {
  id: "11111111-1111-4111-8111-111111111111",
  type: "user",
  name: "Ada",
  email: null,
  permissions: ["zeteo.grants.read"],
};

describe("me.get", () => {
  const t = useStubbedClient();

  it("sends GET /v1/me as the service and returns the body", async () => {
    t.stub.respond(() => ({ body: me }));
    expect(await t.client.me.get()).toEqual(me);
    const [request] = t.stub.requests;
    expect(request.method).toBe("GET");
    expect(request.path).toBe("/v1/me");
    expect(request.query).toEqual({});
    expect(request.body).toBeUndefined();
  });

  it("sends the person's token under withToken", async () => {
    t.stub.respond(() => ({ body: me }));
    await t.client.withToken("p-1").me.get();
    expect(t.stub.requests[0].headers.authorization).toBe("Bearer p-1");
  });

  it("throws on a 401", async () => {
    t.stub.respond(() => ({ status: 401, body: { error: "unauthorized" } }));
    await expect(t.client.withToken("p-1").me.get()).rejects.toMatchObject({
      status: 401,
      code: "unauthorized",
    });
  });
});

describe("me.runs", () => {
  const t = useStubbedClient();

  it("sends GET /v1/me/runs with its filters and returns the page", async () => {
    const page = {
      data: [{ id: "r1", saved_query: { id: "s1", name: "Orders" } }],
      next_cursor: null,
    };
    t.stub.respond(() => ({ body: page }));
    expect(
      await t.client.me.runs({ outcome: "refused", limit: 3, cursor: "c" })
    ).toEqual(page);
    const [request] = t.stub.requests;
    expect(request.method).toBe("GET");
    expect(request.path).toBe("/v1/me/runs");
    expect(request.query).toEqual({
      outcome: "refused",
      limit: "3",
      cursor: "c",
    });
  });
});

describe("me.principals", () => {
  const t = useStubbedClient();

  it("sends GET /v1/me/principals with type, q and limit", async () => {
    const found = {
      data: [{ type: "user", id: "u1", name: "Ada", status: "active" }],
    };
    t.stub.respond(() => ({ body: found }));
    expect(
      await t.client.me.principals({ type: "user", q: "ad", limit: 5 })
    ).toEqual(found);
    const [request] = t.stub.requests;
    expect(request.method).toBe("GET");
    expect(request.path).toBe("/v1/me/principals");
    expect(request.query).toEqual({ type: "user", q: "ad", limit: "5" });
  });
});
