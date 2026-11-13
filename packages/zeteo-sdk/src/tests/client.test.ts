import type { CreateSourceRequest } from "../types/sources.js";
import { useStubbedClient } from "./support/callContext.js";
import { describe, expect, it } from "vitest";

describe("client", () => {
  const t = useStubbedClient();

  it("sends the service's token, and a person's token through withToken", async () => {
    await t.client.catalog.get({ source: "svc" });
    await t.client.withToken("p1").catalog.get({ source: "person" });
    const [service, person] = t.stub.requests;
    expect(service.headers.authorization).toBe("Bearer svc-1");
    expect(person.headers.authorization).toBe("Bearer p1");
  });

  it("uses the value as given after Bearer", async () => {
    await t.client.withToken("Bearer p1").catalog.get();
    expect(t.stub.requests[0].headers.authorization).toBe("Bearer Bearer p1");
  });

  it("never swaps tokens between two withToken clients used concurrently", async () => {
    const a = t.client.withToken("token-a");
    const b = t.client.withToken("token-b");
    const calls: Promise<unknown>[] = [];
    for (let i = 0; i < 10; i += 1) {
      calls.push(a.catalog.get({ source: `token-a-${i}` }));
      calls.push(b.catalog.get({ source: `token-b-${i}` }));
    }
    await Promise.all(calls);
    expect(t.stub.requests).toHaveLength(20);
    for (const request of t.stub.requests) {
      const who = request.query.source.replace(/-\d+$/, "");
      expect(request.headers.authorization).toBe(`Bearer ${who}`);
    }
  });

  it("does not let withToken change the service client", async () => {
    t.client.withToken("p1");
    await t.client.catalog.get();
    expect(t.stub.requests[0].headers.authorization).toBe("Bearer svc-1");
  });

  it.each(["", undefined, null, 5])("withToken(%j) throws", (token) => {
    expect(() => t.client.withToken(token as never)).toThrow(
      "@zeteo-io/sdk: withToken needs a token"
    );
  });

  it("does not expose its transport", () => {
    expect("transport" in t.client).toBe(false);
  });

  it("ties a source's settings to its type", () => {
    const base = { slug: "sales", name: "Sales", schemas: ["public"] };
    const azure = { host: "h", database: "d", user: "u", password: "p" };
    const ok: CreateSourceRequest = {
      ...base,
      type: "azure-sql",
      settings: azure,
    };
    // @ts-expect-error azure-sql's tls value is not one of postgres'
    const wrong: CreateSourceRequest = {
      ...base,
      type: "postgres",
      settings: { ...azure, tls: "trust-server-certificate" },
    };
    expect([ok, wrong]).toHaveLength(2);
  });
});
