import { startStub, testHandler, type Stub } from "./support/stub.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type RequestConfig } from "@dianemo/core";
import type RequestHandler from "@dianemo/core";
import type { AxiosError } from "axios";
import {
  classifyZeteoError,
  classifyZeteoWrite,
  clientNames,
  registerZeteoTemplate,
  ZETEO_TEMPLATE,
} from "../template.js";

const names = clientNames();
const httpError = (status?: number) =>
  ({ response: status ? { status } : undefined }) as AxiosError;

describe("zeteo template", () => {
  let stub: Stub;
  let handler: RequestHandler;

  const req = (clientName: string, over: Partial<RequestConfig> = {}) =>
    ({
      clientName,
      requestName: "t",
      method: "GET",
      url: "/v1/catalog",
      ...over,
    }) as RequestConfig;

  beforeEach(async () => {
    stub = await startStub();
    handler = testHandler();
    await registerZeteoTemplate(handler);
    await handler.addLocalTemplateClient(ZETEO_TEMPLATE, {
      instanceId: "sdk",
      organizationId: null,
      baseUrl: `${stub.url}/`,
      tereoUrl: stub.url,
      clientId: "svc",
      clientSecret: "shh",
    });
  });

  afterEach(async () => {
    await handler.stop();
    await stub.close();
  });

  it("names the four clients", () => {
    expect(names.serviceOnce).toBe(`${names.service}:once`);
    expect(names.person).toBe(`${names.service}:person`);
    expect(names.personOnce).toBe(`${names.service}:person:once`);
  });

  it("sends the service token and fetches it once for two requests", async () => {
    await handler.handleRequest(req(names.service));
    await handler.handleRequest(req(names.service));
    expect(stub.tokensIssued).toBe(1);
    expect(stub.requests).toHaveLength(2);
    for (const r of stub.requests) {
      expect(r.headers.authorization).toBe("Bearer svc-1");
    }
  });

  it("exchanges the credentials at tereo with Basic auth", async () => {
    let tokenRequest: { auth?: string; body: string } | undefined;
    await stub.close();
    stub = await startStub();
    stub.onToken((auth, body) => (tokenRequest = { auth, body }));
    await handler.addLocalTemplateClient(ZETEO_TEMPLATE, {
      instanceId: "sdk",
      organizationId: null,
      baseUrl: stub.url,
      tereoUrl: stub.url,
      clientId: "svc",
      clientSecret: "shh",
    });
    await handler.handleRequest(req(names.service));
    expect(tokenRequest?.auth).toBe(
      `Basic ${Buffer.from("svc:shh").toString("base64")}`
    );
    expect(tokenRequest?.body).toContain("grant_type=client_credentials");
  });

  it("sends no Authorization from the person client unless the request brings one", async () => {
    await handler.handleRequest(req(names.person));
    await handler.handleRequest(
      req(names.person, { headers: { Authorization: "Bearer p-1" } })
    );
    expect(stub.requests[0].headers.authorization).toBeUndefined();
    expect(stub.requests[1].headers.authorization).toBe("Bearer p-1");
    expect(stub.tokensIssued).toBe(0);
  });

  it("classifies errors", () => {
    expect(classifyZeteoError(httpError(429))).toEqual({ action: "fail" });
    expect(classifyZeteoError(httpError(500))).toBeUndefined();
    expect(classifyZeteoError(httpError(404))).toBeUndefined();
    expect(classifyZeteoError(httpError())).toBeUndefined();
    expect(classifyZeteoWrite(httpError(429))).toEqual({ action: "fail" });
    expect(classifyZeteoWrite(httpError(500))).toEqual({ action: "fail" });
    expect(classifyZeteoWrite(httpError())).toEqual({ action: "fail" });
    expect(classifyZeteoWrite(httpError(404))).toBeUndefined();
  });

  it("retries a 500 on the service client but not on its once client", async () => {
    stub.respond(() => ({ status: 500, body: {} }));
    await handler.handleRequest(req(names.service)).catch(() => undefined);
    expect(stub.requests.length).toBeGreaterThanOrEqual(2);

    const before = stub.requests.length;
    await handler.handleRequest(req(names.serviceOnce)).catch(() => undefined);
    expect(stub.requests.length - before).toBe(1);
  }, 30_000);

  it("returns a 429 at once and does not freeze the client", async () => {
    stub.respond(() =>
      stub.requests.length === 1
        ? { status: 429, headers: { "retry-after": "30" }, body: {} }
        : undefined
    );
    await expect(
      handler.handleRequest(req(names.service))
    ).rejects.toBeDefined();
    const started = Date.now();
    await handler.handleRequest(req(names.service));
    expect(Date.now() - started).toBeLessThan(500);
    expect(stub.requests).toHaveLength(2);
  });
});
