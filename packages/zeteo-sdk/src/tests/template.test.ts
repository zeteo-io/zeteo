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

  it("sends no Authorization from person:once, and never repeats a 429 or 500", async () => {
    await handler.handleRequest(req(names.personOnce));
    expect(stub.requests[0].headers.authorization).toBeUndefined();
    for (const status of [429, 500]) {
      const before = stub.requests.length;
      stub.respond(() => ({ status, body: {} }));
      await handler.handleRequest(req(names.personOnce)).catch(() => undefined);
      expect(stub.requests.length - before).toBe(1);
    }
  }, 30_000);

  it("classifies errors", () => {
    expect(classifyZeteoError(httpError(429))).toEqual({ action: "fail" });
    expect(classifyZeteoError(httpError(502))).toEqual({ action: "fail" });
    expect(classifyZeteoError(httpError(504))).toEqual({ action: "fail" });
    expect(classifyZeteoError(httpError(500))).toEqual({ action: "retry" });
    expect(classifyZeteoError(httpError(503))).toEqual({ action: "retry" });
    expect(classifyZeteoError(httpError(404))).toBeUndefined();
    expect(classifyZeteoError(httpError())).toBeUndefined();
    expect(classifyZeteoWrite(httpError(429))).toEqual({ action: "fail" });
    expect(classifyZeteoWrite(httpError(500))).toEqual({ action: "fail" });
    expect(classifyZeteoWrite(httpError())).toEqual({ action: "fail" });
    expect(classifyZeteoWrite(httpError(404))).toBeUndefined();
  });

  it("retries a 500 once on the service client but not on its once client", async () => {
    stub.respond(() =>
      stub.requests.length === 1 ? { status: 500, body: {} } : undefined
    );
    await handler.handleRequest(req(names.service));
    expect(stub.requests).toHaveLength(2);

    stub.respond(() => ({ status: 500, body: {} }));
    const before = stub.requests.length;
    await handler.handleRequest(req(names.serviceOnce)).catch(() => undefined);
    expect(stub.requests.length - before).toBe(1);
  });

  for (const status of [502, 504]) {
    for (const client of ["service", "person"] as const) {
      it(`returns a ${status} on the ${client} client at once and does not freeze it`, async () => {
        stub.respond(() =>
          stub.requests.length === 1 ? { status, body: {} } : undefined
        );
        await expect(
          handler.handleRequest(req(names[client]))
        ).rejects.toBeDefined();
        expect(stub.requests).toHaveLength(1);
        const started = Date.now();
        await handler.handleRequest(req(names[client]));
        expect(Date.now() - started).toBeLessThan(500);
        expect(stub.requests).toHaveLength(2);
      });
    }
  }

  for (const status of [500, 503]) {
    it(`repeats a ${status} without holding back another call on the client`, async () => {
      stub.respond((r) =>
        r.path === "/v1/catalog" && stub.requests.length === 1
          ? { status, body: {} }
          : undefined
      );
      const first = handler.handleRequest(req(names.service));
      while (stub.requests.length === 0) {
        await new Promise((ok) => setTimeout(ok, 5));
      }
      // Time for the error to reach the handler and for a freeze to be set.
      await new Promise((ok) => setTimeout(ok, 100));
      const started = Date.now();
      await handler.handleRequest(req(names.service, { url: "/v1/sources" }));
      expect(Date.now() - started).toBeLessThan(500);
      const response = await first;
      expect(response.status).toBe(200);
      expect(stub.requests.map((r) => r.path)).toEqual([
        "/v1/catalog",
        "/v1/sources",
        "/v1/catalog",
      ]);
    });
  }

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
