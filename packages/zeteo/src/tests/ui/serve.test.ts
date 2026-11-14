// @module-tag int
// @module-tag platform
// @module-tag security
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import type { Server } from "http";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import path from "path";

const FIXTURE = path.resolve(import.meta.dirname, "../fixtures/ui-dist");
const SHELL = "zeteo-ui-fixture-shell";
const HTML = { Accept: "text/html" };

let server: Server | undefined;

// The router reads the environment when it loads, so each case stubs it and
// loads the app afresh.
const serve = async (env: Record<string, string>) => {
  vi.resetModules();
  vi.stubEnv("UI_CLIENT_ID", "");
  vi.stubEnv("UI_TEREO_URL", "https://core.example.com");
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  const { createApp } = await import("../../app.js");
  server = await new Promise<Server>((resolve) => {
    const s = createApp(null).listen(0, () => resolve(s));
  });
  return `http://localhost:${(server.address() as { port: number }).port}`;
};

const withUi = () => serve({ UI_CLIENT_ID: "zeteo-ui", UI_DIST_PATH: FIXTURE });

/** A raw request, so that dot segments and encoded slashes reach the server as written. */
const raw = async (url: string, target: string) => {
  const { request } = await import("http");
  const u = new URL(url);
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request(
      { host: u.hostname, port: u.port, path: target, headers: HTML },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      }
    );
    req.on("error", reject);
    req.end();
  });
};

afterEach(async () => {
  await new Promise((resolve) => (server ? server.close(resolve) : resolve(0)));
  server = undefined;
  vi.unstubAllEnvs();
});
afterAll(() => vi.resetModules());

describe("the app shell", () => {
  it.each(["/", "/sources/abc/tables", "/sources/"])(
    "answers a page request for %s with index.html, uncached",
    async (p) => {
      const url = await withUi();
      const res = await fetch(`${url}${p}`, { headers: HTML });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
      expect(res.headers.get("cache-control")).toBe("no-cache");
      expect(res.headers.get("vary")).toMatch(/\bAccept\b/);
      expect(res.headers.get("content-security-policy")).toContain(
        "default-src 'self'"
      );
      expect(await res.text()).toContain(SHELL);
    }
  );

  it("answers HEAD without a body", async () => {
    const url = await withUi();
    const res = await fetch(`${url}/sources`, {
      method: "HEAD",
      headers: HTML,
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
  });

  it("answers a browser's Accept header", async () => {
    const url = await withUi();
    const res = await fetch(`${url}/sources`, {
      headers: { Accept: "text/html,application/xhtml+xml,*/*;q=0.8" },
    });
    expect(await res.text()).toContain(SHELL);
  });

  it("answers JSON 404 when the client does not accept HTML", async () => {
    const url = await withUi();
    const res = await fetch(`${url}/sources`, {
      headers: { Accept: "application/json" },
    });
    expect(res.status).toBe(404);
    expect(res.headers.get("vary")).toMatch(/\bAccept\b/);
    expect(JSON.stringify(await res.json())).toContain("not_found");
  });

  it("answers JSON 404 to a non-GET", async () => {
    const url = await withUi();
    for (const method of ["POST", "PUT", "DELETE"]) {
      const res = await fetch(`${url}/sources`, { method, headers: HTML });
      expect(res.status).toBe(404);
      expect(res.headers.get("content-type")).toContain("json");
    }
  });

  it.each(["/favicon.ico", "/robots.txt", "/sources/x.map"])(
    "does not answer a missing file-looking path %s with HTML",
    async (p) => {
      const url = await withUi();
      const res = await fetch(`${url}${p}`, { headers: HTML });
      expect(res.status).toBe(404);
      expect(res.headers.get("content-type")).toContain("json");
    }
  );

  it.each([
    "/v1/nope",
    "/V1/nope",
    "/v1",
    "/v1/",
    "/health/x",
    "/mcp/x",
    "/.well-known/x",
    "/assets/missing.js",
    "/assets/",
    "/assets/sub/deeper",
  ])("never answers %s with HTML", async (p) => {
    const url = await withUi();
    const res = await fetch(`${url}${p}`, { headers: HTML });
    expect(res.headers.get("content-type") ?? "").not.toContain("text/html");
    expect(await res.text()).not.toContain(SHELL);
  });

  it("answers an unreserved lookalike like /v1x with the shell", async () => {
    const url = await withUi();
    const res = await fetch(`${url}/v1x`, { headers: HTML });
    expect(await res.text()).toContain(SHELL);
  });

  it("leaves /ui-config.json to its own router", async () => {
    const url = await withUi();
    const res = await fetch(`${url}/ui-config.json`, { headers: HTML });
    expect(res.headers.get("content-type")).toContain("json");
    const post = await fetch(`${url}/UI-CONFIG.JSON/`, { headers: HTML });
    expect(await post.text()).not.toContain(SHELL);
  });

  it("keeps /health answering", async () => {
    const url = await withUi();
    const res = await fetch(`${url}/health`, { headers: HTML });
    expect(res.status).toBe(200);
    expect(await res.text()).not.toContain(SHELL);
  });
});

describe("static files", () => {
  it("serves assets immutable", async () => {
    const url = await withUi();
    const res = await fetch(`${url}/assets/app.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe(
      "public, max-age=31536000, immutable"
    );
    expect(await res.text()).toContain("fixture");
  });

  it("serves other files uncached", async () => {
    const url = await withUi();
    const res = await fetch(`${url}/favicon.svg`);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-cache");
    expect(res.headers.get("content-type")).toContain("image/svg+xml");
  });

  it("serves index.html itself as a file, uncached", async () => {
    const url = await withUi();
    const res = await fetch(`${url}/index.html`);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-cache");
  });

  it("answers a missing asset with JSON 404, not the shell", async () => {
    const url = await withUi();
    const res = await fetch(`${url}/assets/missing.js`, { headers: HTML });
    expect(res.status).toBe(404);
    expect(JSON.stringify(await res.json())).toContain("not_found");
  });

  it("has no CSP gap on static responses", async () => {
    const url = await withUi();
    const res = await fetch(`${url}/assets/app.js`);
    expect(res.headers.get("content-security-policy")).toContain(
      "frame-ancestors 'none'"
    );
  });
});

describe("path traversal and dotfiles", () => {
  it.each(["/.env", "/.git/config", "/assets/.env"])(
    "answers 404 for %s",
    async (p) => {
      const url = await withUi();
      const res = await raw(url, p);
      expect(res.status).toBe(404);
    }
  );

  it.each([
    "/..%2fpackage.json",
    "/%2e%2e/package.json",
    "/%2e%2e%2fpackage.json",
    "/../package.json",
    "/assets/..%2f..%2findex.html",
    "/assets/..%2f..%2fpackage.json",
    "/assets/%2e%2e/%2e%2e/package.json",
    "/..%5cpackage.json",
    "/%00",
    "/assets/app.js%00.html",
  ])("never serves a file from outside the build for %s", async (p) => {
    const url = await withUi();
    const res = await raw(url, p);
    expect(res.body).not.toContain('"name": "zeteo"');
    expect(res.body).not.toContain('"name"');
    expect([200, 400, 403, 404]).toContain(res.status);
    if (res.status === 200) {
      expect(res.body).toContain(SHELL);
    }
  });
});

describe("when the UI is not served", () => {
  it("answers JSON 404 at / without UI_CLIENT_ID, and /health still answers", async () => {
    const url = await serve({ UI_DIST_PATH: FIXTURE });
    const res = await fetch(`${url}/`, { headers: HTML });
    expect(res.status).toBe(404);
    expect(JSON.stringify(await res.json())).toContain("not_found");
    expect((await fetch(`${url}/health`)).status).toBe(200);
  });

  it("answers JSON 404 at / when the build directory is empty", async () => {
    const empty = mkdtempSync(path.join(tmpdir(), "zeteo-ui-empty-"));
    const url = await serve({ UI_CLIENT_ID: "zeteo-ui", UI_DIST_PATH: empty });
    const res = await fetch(`${url}/`, { headers: HTML });
    expect(res.status).toBe(404);
    expect(JSON.stringify(await res.json())).toContain("not_found");
    expect((await fetch(`${url}/health`)).status).toBe(200);
  });
});
