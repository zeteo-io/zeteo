import { startStub, testHandler, type Stub } from "./support/stub.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type RequestHandler from "@dianemo/core";
import type { Readable } from "node:stream";
import {
  buildClientName,
  type ErrorClassifier,
  type RequestConfig,
  type TokenCredentials,
} from "@dianemo/core";

declare module "@dianemo/core" {
  interface ClientTemplates {
    proof: TokenCredentials;
  }
}

describe("request handler transport", () => {
  let stub: Stub;
  let handler: RequestHandler;
  let clientName: string;

  const register = async (classifyError?: ErrorClassifier) => {
    await handler.registerClientTemplate("proof", (creds) => [
      {
        name: buildClientName("proof", creds),
        requestOptions: { defaults: { baseURL: creds.baseUrl } },
        ...(classifyError ? { retryOptions: { classifyError } } : {}),
      },
    ]);
    const creds = { instanceId: "t", baseUrl: stub.url, token: "unused" };
    await handler.addTemplateClient("proof", creds);
    clientName = buildClientName("proof", creds);
  };

  const req = (over: Partial<RequestConfig> = {}): RequestConfig => ({
    clientName,
    requestName: "t",
    method: "GET",
    url: "/v1/catalog",
    ...over,
  });

  beforeEach(async () => {
    stub = await startStub();
    handler = testHandler();
  });

  afterEach(async () => {
    await handler.stop();
    await stub.close();
  });

  it("sends a per-request Authorization header through a client that declares no authentication", async () => {
    await register();
    await handler.handleRequest(
      req({ headers: { Authorization: "Bearer person-1" } })
    );
    expect(stub.requests[0].headers.authorization).toBe("Bearer person-1");
  });

  it("streams a response and lets the caller read it", async () => {
    await register();
    stub.respond(() => ({ chunks: ['{"a":1}\n', '{"b":2}\n'] }));
    const res = await handler.handleRequest<Readable>(
      req({ method: "POST", url: "/v1/export", responseType: "stream" })
    );
    const text = await new Promise<string>((ok) => {
      let s = "";
      res.data.on("data", (c: Buffer) => (s += c));
      res.data.on("end", () => ok(s));
    });
    expect(text).toBe('{"a":1}\n{"b":2}\n');
    expect(await res.dianemo!.finished).toBe("completed");
  });

  it("lets the caller abandon a stream", async () => {
    await register();
    stub.respond(() => ({
      chunks: Array.from({ length: 50 }, (_, i) => `[${i}]\n`),
    }));
    const res = await handler.handleRequest<Readable>(
      req({ method: "POST", url: "/v1/export", responseType: "stream" })
    );
    res.data.destroy();
    expect(await res.dianemo!.finished).toBe("closed");
  });

  it("returns a 429 at once when the classifier says fail, and does not freeze the client", async () => {
    await register((e) =>
      e.response?.status === 429 ? { action: "fail" } : undefined
    );
    stub.respond(() =>
      stub.requests.length === 1
        ? { status: 429, headers: { "retry-after": "30" }, body: {} }
        : undefined
    );
    await expect(handler.handleRequest(req())).rejects.toMatchObject({
      response: { status: 429 },
    });
    const started = Date.now();
    await handler.handleRequest(req());
    expect(Date.now() - started).toBeLessThan(500);
    expect(stub.requests).toHaveLength(2);
  });
});
