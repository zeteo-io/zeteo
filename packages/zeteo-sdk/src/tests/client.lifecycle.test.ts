import { startStub, testHandler, type Stub } from "./support/stub.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import RequestHandler, { memoryBackend } from "@dianemo/core";
import { createZeteoClient } from "../client.js";
import { Redis } from "ioredis";

describe("createZeteoClient lifecycle", () => {
  let stub: Stub;
  beforeEach(async () => {
    stub = await startStub();
  });
  afterEach(async () => {
    await stub.close();
  });

  const base = () => ({
    url: stub.url,
    tereoUrl: stub.url,
    clientId: "svc",
    clientSecret: "shh",
  });

  it("refuses a handler together with redis", () => {
    const redis = new Redis({ lazyConnect: true });
    expect(() =>
      createZeteoClient({
        ...base(),
        handler: testHandler(),
        redis,
        requestHandlerKey: "k".repeat(32),
      } as never)
    ).toThrow(
      "@zeteo-io/sdk: pass either handler, or redis and requestHandlerKey, not both"
    );
    redis.disconnect();
  });

  it("refuses neither a handler nor redis with a key", () => {
    const redis = new Redis({ lazyConnect: true });
    expect(() => createZeteoClient(base() as never)).toThrow(
      "@zeteo-io/sdk: pass handler, or redis and requestHandlerKey"
    );
    expect(() => createZeteoClient({ ...base(), redis } as never)).toThrow(
      "@zeteo-io/sdk: pass handler, or redis and requestHandlerKey"
    );
    redis.disconnect();
  });

  it("refuses a second zeteo client on one handler", async () => {
    const handler = testHandler();
    createZeteoClient({ ...base(), handler });
    expect(() => createZeteoClient({ ...base(), handler })).toThrow(
      "@zeteo-io/sdk: a zeteo client is already registered on this handler"
    );
    await handler.stop();
  });

  it("leaves a passed-in handler running after stop()", async () => {
    const handler = testHandler();
    const zeteo = createZeteoClient({ ...base(), handler });
    await zeteo.start();
    await zeteo.stop();
    await handler.handleRequest({
      clientName: zeteo.transport.names.service,
      requestName: "t",
      method: "GET",
      url: "/v1/catalog",
    });
    expect(stub.requests).toHaveLength(1);
    await handler.stop();
  });

  it("works on a handler that was already started", async () => {
    const handler = testHandler();
    await handler.start();
    const zeteo = createZeteoClient({ ...base(), handler });
    await zeteo.start();
    await handler.handleRequest({
      clientName: zeteo.transport.names.service,
      requestName: "t",
      method: "GET",
      url: "/v1/catalog",
    });
    expect(stub.requests[0].headers.authorization).toBe("Bearer svc-1");
    await handler.stop();
  });

  it("adds the client on a handler that is mid-start past its hooks", async () => {
    // Once the hooks are done, the backend answers slowly, which holds the
    // start in "starting" long enough to create the client inside that window.
    let slow = false;
    const mem = memoryBackend();
    const backend = new Proxy(mem, {
      get(target, prop, recv) {
        const v = Reflect.get(target, prop, recv);
        if (typeof v !== "function") return v;
        return async (...args: unknown[]) => {
          if (slow) await new Promise((ok) => setTimeout(ok, 30));
          return v.apply(target, args);
        };
      },
    });
    const handler = new RequestHandler({ key: "k".repeat(32), backend });
    let zeteo: ReturnType<typeof createZeteoClient> | undefined;
    let statusAtCreate: string | undefined;
    handler.registerStartupHook(() => {
      slow = true;
      setTimeout(() => {
        statusAtCreate = handler.getMetadata().status;
        zeteo = createZeteoClient({ ...base(), handler });
      }, 5);
    });
    const starting = handler.start();
    while (!zeteo) await new Promise((ok) => setTimeout(ok, 1));
    expect(statusAtCreate).toBe("starting");
    await zeteo.start();
    await starting;
    await handler.handleRequest({
      clientName: zeteo.transport.names.service,
      requestName: "t",
      method: "GET",
      url: "/v1/catalog",
    });
    expect(stub.requests[0].headers.authorization).toBe("Bearer svc-1");
    await handler.stop();
  });

  it("builds its own handler when handler is explicitly undefined", () => {
    const redis = new Redis({ lazyConnect: true });
    const zeteo = createZeteoClient({
      ...base(),
      handler: undefined,
      redis,
      requestHandlerKey: "k".repeat(32),
    } as never);
    expect(zeteo.transport.handler).toBeDefined();
    redis.disconnect();
  });

  it("builds its own handler from redis, namespaced by client id", async () => {
    const redis = new Redis({ lazyConnect: true });
    const zeteo = createZeteoClient({
      ...base(),
      redis,
      requestHandlerKey: "k".repeat(32),
    });
    // No public accessor for the namespace.
    const internal = zeteo.transport.handler as unknown as {
      namespace: string;
    };
    expect(internal.namespace).toContain("@zeteo-io/sdk:svc");
    expect(zeteo.transport.handler.getMetadata().priority).toBe(1);
    redis.disconnect();
  });
});
