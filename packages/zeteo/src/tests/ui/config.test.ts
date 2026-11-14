// @module-tag int
// @module-tag platform
// @module-tag security
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { BASE_URL } from "../support/http.js";
import type { Server } from "http";

// The router reads the environment when it loads, so each case stubs it and
// loads the module afresh.
let server: Server | undefined;

const serve = async (env: Record<string, string>) => {
  vi.resetModules();
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  const { default: express } = await import("express");
  const { errorHandler, NotFoundError } = await import("../../utils/errors.js");
  const { uiConfigRouter } = await import("../../ui/config.js");
  const app = express();
  app.use(uiConfigRouter);
  app.use(() => {
    throw new NotFoundError("Not found");
  });
  app.use(errorHandler);
  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  return `http://localhost:${(server.address() as { port: number }).port}`;
};

afterEach(async () => {
  await new Promise((resolve) => (server ? server.close(resolve) : resolve(0)));
  server = undefined;
  vi.unstubAllEnvs();
});
afterAll(() => vi.resetModules());

describe("GET /ui-config.json", () => {
  it("hands the browser Tereo's URL and the client id, uncached, without a sign-in", async () => {
    const url = await serve({
      UI_CLIENT_ID: "zeteo-ui",
      UI_TEREO_URL: "https://core.example.com/",
      TEREO_URL: "http://tereo.internal:4001",
    });
    const res = await fetch(`${url}/ui-config.json`);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-cache");
    expect(await res.json()).toEqual({
      tereo_url: "https://core.example.com",
      client_id: "zeteo-ui",
    });
  });

  it("falls back to TEREO_URL when UI_TEREO_URL is unset", async () => {
    const url = await serve({
      UI_CLIENT_ID: "zeteo-ui",
      TEREO_URL: "https://tereo.example.com",
    });
    const res = await fetch(`${url}/ui-config.json`);
    expect(await res.json()).toEqual({
      tereo_url: "https://tereo.example.com",
      client_id: "zeteo-ui",
    });
  });

  it("answers 404 not_found without UI_CLIENT_ID", async () => {
    vi.stubEnv("UI_CLIENT_ID", "");
    const url = await serve({});
    const res = await fetch(`${url}/ui-config.json`);
    expect(res.status).toBe(404);
    expect(JSON.stringify(await res.json())).toContain("not_found");
  });

  it("serves only GET and HEAD", async () => {
    const url = await serve({
      UI_CLIENT_ID: "zeteo-ui",
      TEREO_URL: "https://tereo.example.com",
    });
    expect(
      (await fetch(`${url}/ui-config.json`, { method: "HEAD" })).status
    ).toBe(200);
    expect(
      (await fetch(`${url}/ui-config.json`, { method: "POST" })).status
    ).toBe(404);
  });
});

describe("content security policy on the running service", () => {
  it.each(["/health", "/v1/catalog", "/nowhere", "/mcp"])(
    "is set on %s",
    async (path) => {
      const res = await fetch(`${BASE_URL}${path}`);
      const csp = res.headers.get("content-security-policy");
      expect(csp).toContain("frame-ancestors 'none'");
      expect(csp).toContain("default-src 'self'");
      expect(csp).not.toContain("core.example.com");
    }
  );
});
