import { startStub, testHandler, type Stub } from "./support/stub.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createZeteoClient, type ZeteoClient } from "../client.js";
import { QueryRefusedError, ZeteoError } from "../errors.js";
import { send, sendRaw, type CallContext } from "../send.js";
import type RequestHandler from "@dianemo/core";

const catchError = async (p: Promise<unknown>): Promise<ZeteoError> => {
  try {
    await p;
  } catch (e) {
    return e as ZeteoError;
  }
  throw new Error("did not throw");
};

describe("send", () => {
  let stub: Stub;
  let handler: RequestHandler;
  let client: ZeteoClient;
  let requestId: string | undefined;

  const ctx = (token?: string): CallContext => ({
    transport: client.transport,
    token,
  });

  beforeEach(async () => {
    stub = await startStub();
    handler = testHandler();
    requestId = undefined;
    client = createZeteoClient({
      handler,
      url: stub.url,
      tereoUrl: stub.url,
      clientId: "svc",
      clientSecret: "client-secret-1",
      getRequestId: () => requestId,
    });
    await client.start();
  });

  afterEach(async () => {
    await handler.stop();
    await stub.close();
  });

  it("returns the body and builds the path, query and body", async () => {
    stub.respond(() => ({ body: { id: "s1" } }));
    const out = await send<{ id: string }>(ctx(), {
      op: "updateSource",
      params: { sourceId: "s 1" },
      query: { a: "x", b: undefined, c: 3 },
      body: { name: "n" },
    });
    expect(out).toEqual({ id: "s1" });
    expect(stub.requests[0]).toMatchObject({
      method: "PATCH",
      path: "/v1/sources/s%201",
      query: { a: "x", c: "3" },
      body: { name: "n" },
    });
  });

  it("uses the service token without a person token, and the person's with one", async () => {
    await send(ctx(), { op: "getCatalog" });
    await send(ctx("p-1"), { op: "getCatalog" });
    await send(ctx(), { op: "getCatalog", once: true });
    await send(ctx("p-2"), { op: "getCatalog", once: true });
    expect(stub.requests.map((r) => r.headers.authorization)).toEqual([
      "Bearer svc-1",
      "Bearer p-1",
      "Bearer svc-1",
      "Bearer p-2",
    ]);
  });

  it("picks the client by token and once", async () => {
    const seen: string[] = [];
    const real = handler.handleRequest.bind(handler);
    (handler as unknown as { handleRequest: unknown }).handleRequest =
      (config: { clientName: string; requestName: string }) => {
        seen.push(`${config.clientName}|${config.requestName}`);
        return real(config as never);
      };
    const { names } = client.transport;
    await send(ctx(), { op: "getCatalog" });
    await send(ctx(), { op: "getCatalog", once: true });
    await send(ctx("p"), { op: "getCatalog" });
    await send(ctx("p"), { op: "getCatalog", once: true });
    expect(seen).toEqual([
      `${names.service}|zeteo.getCatalog`,
      `${names.serviceOnce}|zeteo.getCatalog`,
      `${names.person}|zeteo.getCatalog`,
      `${names.personOnce}|zeteo.getCatalog`,
    ]);
  });

  it("forwards X-Request-ID when there is one", async () => {
    await send(ctx(), { op: "getCatalog" });
    requestId = "req-9";
    await send(ctx(), { op: "getCatalog" });
    expect(stub.requests[0].headers["x-request-id"]).toBeUndefined();
    expect(stub.requests[1].headers["x-request-id"]).toBe("req-9");
  });

  it("maps an error body", async () => {
    stub.respond(() => ({
      status: 400,
      headers: { "x-request-id": "h-1", "retry-after": "7" },
      body: {
        error: "bad_thing",
        error_description: "it broke",
        request_id: "b-1",
        retry_after: 3,
        issues: [{ path: "name", message: "required" }],
        findings: [{ a: 1 }],
      },
    }));
    const err = await catchError(send(ctx(), { op: "createSource" }));
    expect(err).toBeInstanceOf(ZeteoError);
    expect(err).not.toBeInstanceOf(QueryRefusedError);
    expect(err).toMatchObject({
      status: 400,
      code: "bad_thing",
      message: "it broke",
      requestId: "b-1",
      retryAfter: 3,
      issues: [{ path: "name", message: "required" }],
      findings: [{ a: 1 }],
    });
  });

  it("falls back to http_<status>, the status text and the headers", async () => {
    stub.respond(() => ({
      status: 429,
      headers: { "x-request-id": "h-1", "retry-after": "30" },
      body: {},
    }));
    const err = await catchError(send(ctx(), { op: "runQuery" }));
    expect(err).toMatchObject({
      status: 429,
      code: "http_429",
      message: "Too Many Requests",
      requestId: "h-1",
      retryAfter: 30,
    });
    expect(stub.requests).toHaveLength(1);
  });

  it("maps a 422 with a path to QueryRefusedError", async () => {
    stub.respond(() => ({
      status: 422,
      body: {
        error: "invalid_operator",
        error_description: "x",
        path: ["where", "status"],
        suggestions: ["state"],
      },
    }));
    const err = await catchError(send(ctx(), { op: "runQuery" }));
    expect(err).toBeInstanceOf(QueryRefusedError);
    expect(err).toMatchObject({
      status: 422,
      code: "invalid_operator",
      path: ["where", "status"],
      suggestions: ["state"],
    });
  });

  it("returns null for a 404 only with nullOn404", async () => {
    stub.respond(() => ({ status: 404, body: { error: "not_found" } }));
    expect(
      await send(ctx(), {
        op: "getGrant",
        params: { grantId: "g" },
        nullOn404: true,
      })
    ).toBeNull();
    const err = await catchError(
      send(ctx(), { op: "getGrant", params: { grantId: "g" } })
    );
    expect(err).toMatchObject({ status: 404, code: "not_found" });
  });

  it("renews the service token once on a 401", async () => {
    stub.respond((r) =>
      r.headers.authorization === "Bearer svc-1"
        ? { status: 401, body: { error: "invalid_token" } }
        : undefined
    );
    await send(ctx(), { op: "getCatalog" });
    expect(stub.tokensIssued).toBe(2);
    expect(stub.requests.map((r) => r.headers.authorization)).toEqual([
      "Bearer svc-1",
      "Bearer svc-2",
    ]);
  });

  it("throws a second 401", async () => {
    stub.respond(() => ({ status: 401, body: { error: "invalid_token" } }));
    const err = await catchError(send(ctx(), { op: "getCatalog" }));
    expect(err).toMatchObject({ status: 401, code: "invalid_token" });
    expect(stub.requests).toHaveLength(2);
    expect(stub.tokensIssued).toBe(2);
  });

  it("throws a 401 for a person token at once", async () => {
    await send(ctx(), { op: "getCatalog" });
    expect(stub.tokensIssued).toBe(1);
    stub.respond(() => ({ status: 401, body: { error: "invalid_token" } }));
    const before = stub.requests.length;
    const err = await catchError(send(ctx("p-1"), { op: "getCatalog" }));
    expect(err.status).toBe(401);
    expect(stub.requests.length - before).toBe(1);
    expect(stub.tokensIssued).toBe(1);
  });

  it("reports unreachable when the server is gone", async () => {
    await stub.close();
    const err = await catchError(
      send(ctx("p-1"), { op: "getCatalog", once: true })
    );
    expect(err).toMatchObject({ status: null, code: "unreachable" });
    expect(err.cause).toBeInstanceOf(Error);
    expect(err.cause?.constructor).toBe(Error);
    stub = await startStub();
  }, 30_000);

  it("reports aborted for an aborted signal", async () => {
    const controller = new AbortController();
    controller.abort();
    const err = await catchError(
      send(ctx(), { op: "getCatalog", signal: controller.signal })
    );
    expect(err).toMatchObject({ status: null, code: "aborted" });
    expect(stub.requests).toHaveLength(0);
  });

  it("refuses a bad id without a request", async () => {
    const err = await catchError(
      send(ctx(), { op: "getSource", params: { sourceId: "a/b" } })
    );
    expect(err).toMatchObject({ status: null, code: "invalid_id" });
    expect(stub.requests).toHaveLength(0);
  });

  it("sendRaw returns the untouched response", async () => {
    stub.respond(() => ({ body: { a: 1 } }));
    const res = await sendRaw(ctx(), { op: "exportQuery", body: {} });
    expect(res.status).toBe(200);
    expect(res.data).toEqual({ a: 1 });
  });

  it("sendRaw maps an error status with a parsed body", async () => {
    stub.respond(() => ({ status: 403, body: { error: "forbidden" } }));
    const err = await catchError(
      sendRaw(ctx(), { op: "exportQuery", body: {} })
    );
    expect(err).toMatchObject({ status: 403, code: "forbidden" });
  });

  it("sendRaw maps an error status whose body is a stream by status only", async () => {
    stub.respond(() => ({ status: 403, chunks: ['{"error":"forbidden"}'] }));
    const err = await catchError(
      sendRaw(ctx(), { op: "exportQuery", body: {}, stream: true })
    );
    expect(err).toMatchObject({ status: 403, code: "http_403" });
  });

  it("leaks no secret into a thrown error", async () => {
    stub.respond(() => ({
      status: 500,
      body: { error: "boom", error_description: "failed" },
    }));
    const errors = [
      await catchError(
        send(ctx("person-secret-1"), { op: "getCatalog", once: true })
      ),
      await catchError(send(ctx(), { op: "getCatalog", once: true })),
    ];
    await stub.close();
    errors.push(
      await catchError(
        send(ctx("person-secret-1"), { op: "getCatalog", once: true })
      )
    );
    stub = await startStub();

    const seen = new Set<unknown>();
    const walk = (value: unknown): unknown => {
      if (typeof value !== "object" || value === null) return value;
      if (seen.has(value)) return "[circular]";
      seen.add(value);
      const out: Record<string, unknown> = {};
      for (const key of Object.getOwnPropertyNames(value)) {
        out[key] = walk((value as Record<string, unknown>)[key]);
      }
      return out;
    };
    for (const error of errors) {
      seen.clear();
      const text = JSON.stringify(walk(error));
      expect(text).toContain("message");
      expect(text).not.toContain("person-secret-1");
      expect(text).not.toContain("client-secret-1");
      expect(text).not.toContain("svc-");
      expect(text).not.toContain("Bearer");
      expect(text).not.toContain("AxiosError");
    }
  }, 30_000);
});
