import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type RequestConfig } from "@dianemo/core";
import type RequestHandler from "@dianemo/core";
import type { AxiosError } from "axios";
import {
  startStub,
  testHandler,
  type Stub,
  type StubResponse,
} from "./support/stub.js";
import {
  classifyZeteoError,
  classifyZeteoWrite,
  clientNames,
  instanceIdFor,
  registerZeteoTemplate,
  ZETEO_TEMPLATE,
} from "../template.js";

const names = clientNames("svc");
const httpError = (status?: number, data?: unknown) =>
  ({ response: status ? { status, data } : undefined }) as AxiosError;

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
      instanceId: instanceIdFor("svc"),
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

  it("names the clients after the client id", () => {
    expect(clientNames("a").service).not.toBe(clientNames("b").service);
    expect(clientNames("a").service).toContain(instanceIdFor("a"));
    // Distinct ids stay distinct once encoded into a name segment.
    const ids = ["a:b", "a%3Ab", "a b", "a_b", "", "sdk"];
    const segments = ids.map(instanceIdFor);
    expect(new Set(segments).size).toBe(ids.length);
    for (const segment of segments) expect(segment).toMatch(/^[^:\s]+$/);
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
      instanceId: instanceIdFor("svc"),
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
    for (const [status, error] of [
      [502, "query_failed"],
      [502, "source_unreachable"],
      [504, "query_timeout"],
    ] as const) {
      expect(classifyZeteoError(httpError(status, { error }))).toEqual({
        action: "fail",
      });
    }
    for (const data of [
      undefined,
      "",
      "<html></html>",
      '{"error":"query_failed"}',
      { error: "bad_gateway" },
      ["query_failed"],
      null,
    ]) {
      expect(classifyZeteoError(httpError(502, data))).toEqual({
        action: "retry",
      });
      expect(classifyZeteoError(httpError(504, data))).toEqual({
        action: "retry",
      });
    }
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

  const zeteoFailures = [
    { status: 502, error: "query_failed" },
    { status: 502, error: "source_unreachable" },
    { status: 504, error: "query_timeout" },
  ];

  for (const client of ["service", "person"] as const) {
    for (const { status, error } of zeteoFailures) {
      it(`returns zeteo's ${status} ${error} on the ${client} client at once and does not freeze it`, async () => {
        stub.respond(() =>
          stub.requests.length === 1 ? { status, body: { error } } : undefined
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

    // All cases run at once, each on its own path, so the backoff before the
    // repeats is paid once.
    it(`repeats a 500, a 503 and a gateway's 502 or 504 on the ${client} client without holding back another call`, async () => {
      const cases: Record<string, StubResponse> = {
        "500": { status: 500, body: {} },
        "503": { status: 503, body: { error: "temporarily_unavailable" } },
        "502-html": {
          status: 502,
          headers: { "content-type": "text/html" },
          chunks: ["<html><body>502 Bad Gateway</body></html>"],
        },
        "502-empty": { status: 502, chunks: [] },
        "504-other": { status: 504, body: { error: "gateway_timeout" } },
      };
      const seen = new Map<string, number>();
      stub.respond((r) => {
        const name = r.path.replace("/v1/r/", "");
        const n = (seen.get(name) ?? 0) + 1;
        seen.set(name, n);
        return n === 1 ? cases[name] : undefined;
      });
      const calls = Object.keys(cases).map((name) =>
        handler.handleRequest(req(names[client], { url: `/v1/r/${name}` }))
      );
      while (stub.requests.length < calls.length) {
        await new Promise((ok) => setTimeout(ok, 5));
      }
      // Time for the errors to reach the handler and for a freeze to be set.
      await new Promise((ok) => setTimeout(ok, 100));
      const started = Date.now();
      await handler.handleRequest(req(names[client], { url: "/v1/sources" }));
      expect(Date.now() - started).toBeLessThan(500);
      const responses = await Promise.all(calls);
      expect(responses.map((r) => r.status)).toEqual(calls.map(() => 200));
      expect(Object.fromEntries(seen)).toEqual({
        "500": 2,
        "503": 2,
        "502-html": 2,
        "502-empty": 2,
        "504-other": 2,
        "/v1/sources": 1,
      });
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
