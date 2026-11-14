// @module-tag int
// @module-tag platform
// @module-tag security
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Server } from "http";

let server: Server | undefined;

const headerOf = async (env: Record<string, string>) => {
  vi.resetModules();
  vi.stubEnv("UI_CLIENT_ID", "");
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  const { createApp } = await import("../../app.js");
  server = await new Promise<Server>((resolve) => {
    const s = createApp(null).listen(0, () => resolve(s));
  });
  const port = (server.address() as { port: number }).port;
  const res = await fetch(`http://localhost:${port}/health`);
  return res.headers.get("content-security-policy") ?? "";
};

afterEach(async () => {
  await new Promise((resolve) => (server ? server.close(resolve) : resolve(0)));
  server = undefined;
  vi.unstubAllEnvs();
});

describe("createApp's content security policy", () => {
  it("names the Tereo origin in connect-src and upgrades requests on https", async () => {
    const csp = await headerOf({
      UI_CLIENT_ID: "zeteo-ui",
      UI_TEREO_URL: "https://core.example.com/base/",
      PUBLIC_URL: "https://zeteo.example.com",
    });
    expect(csp).toContain("connect-src 'self' https://core.example.com;");
    expect(csp).toMatch(/(^|;)upgrade-insecure-requests(;|$)/);
  });

  it("names no Tereo origin and does not upgrade on http without a UI", async () => {
    const csp = await headerOf({
      UI_TEREO_URL: "https://core.example.com",
      PUBLIC_URL: "http://localhost:4201",
    });
    expect(csp).toContain("connect-src 'self';");
    expect(csp).not.toContain("upgrade-insecure-requests");
  });
});
