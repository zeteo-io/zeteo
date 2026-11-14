import { useStubbedClient } from "../support/callContext.js";
import { describe, expect, it } from "vitest";

const ID = "11111111-1111-4111-8111-111111111111";
const ID2 = "22222222-2222-4222-8222-222222222222";
const found = {
  data: [
    { type: "user", id: ID, name: "Ada", email: "a@x.io", status: "active" },
  ],
};

describe("principals.search", () => {
  const t = useStubbedClient();

  it("sends GET /v1/principals with type, q and limit", async () => {
    t.stub.respond(() => ({ body: found }));
    const result = await t.client.principals.search({
      type: "user",
      q: "ad",
      limit: 5,
    });
    expect(result).toEqual(found);
    const [request] = t.stub.requests;
    expect(request.method).toBe("GET");
    expect(request.path).toBe("/v1/principals");
    expect(request.query).toEqual({ type: "user", q: "ad", limit: "5" });
    expect(request.body).toBeUndefined();
  });

  it("leaves limit out when not given", async () => {
    t.stub.respond(() => ({ body: found }));
    await t.client.principals.search({ type: "group", q: "eng" });
    expect(t.stub.requests[0].query).toEqual({ type: "group", q: "eng" });
  });

  it("sends the person's token under withToken", async () => {
    t.stub.respond(() => ({ body: found }));
    await t.client
      .withToken("p-1")
      .principals.search({ type: "user", q: "ad" });
    expect(t.stub.requests[0].headers.authorization).toBe("Bearer p-1");
  });

  it("throws a 404 rather than resolving null", async () => {
    t.stub.respond(() => ({ status: 404, body: { error: "not_found" } }));
    await expect(
      t.client.principals.search({ type: "user", q: "ad" })
    ).rejects.toMatchObject({ status: 404, code: "not_found" });
  });

  it("surfaces a 429 as ZeteoError with retryAfter", async () => {
    t.stub.respond(() => ({
      status: 429,
      headers: { "retry-after": "7" },
      body: { error: "too_many_requests" },
    }));
    await expect(
      t.client.principals.search({ type: "user", q: "ad" })
    ).rejects.toMatchObject({
      name: "ZeteoError",
      status: 429,
      code: "too_many_requests",
      retryAfter: 7,
    });
    expect(t.stub.requests).toHaveLength(1);
  });
});

describe("principals.lookup", () => {
  const t = useStubbedClient();
  const refs = [
    { type: "user" as const, id: ID },
    { type: "group" as const, id: ID2 },
  ];

  it("sends POST /v1/principals/lookup with { principals }", async () => {
    t.stub.respond(() => ({ body: found }));
    expect(await t.client.principals.lookup(refs)).toEqual(found);
    const [request] = t.stub.requests;
    expect(request.method).toBe("POST");
    expect(request.path).toBe("/v1/principals/lookup");
    expect(request.query).toEqual({});
    expect(request.body).toEqual({ principals: refs });
  });

  it("sends the person's token under withToken", async () => {
    t.stub.respond(() => ({ body: found }));
    await t.client.withToken("p-1").principals.lookup(refs);
    expect(t.stub.requests[0].headers.authorization).toBe("Bearer p-1");
  });

  it("is repeated after a 503, unlike a write", async () => {
    let n = 0;
    t.stub.respond(() => {
      n += 1;
      return n === 1
        ? { status: 503, body: { error: "temporarily_unavailable" } }
        : { body: found };
    });
    expect(await t.client.principals.lookup(refs)).toEqual(found);
    expect(t.stub.requests).toHaveLength(2);
  }, 15_000);

  it("is repeated after a 500", async () => {
    let n = 0;
    t.stub.respond(() => {
      n += 1;
      return n === 1
        ? { status: 500, body: { error: "boom" } }
        : { body: found };
    });
    await t.client.principals.lookup(refs);
    expect(t.stub.requests).toHaveLength(2);
  }, 15_000);

  it("throws a 404", async () => {
    t.stub.respond(() => ({ status: 404, body: { error: "not_found" } }));
    await expect(t.client.principals.lookup(refs)).rejects.toMatchObject({
      status: 404,
    });
  });
});
