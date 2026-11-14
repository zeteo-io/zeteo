// @module-tag unit
// @module-tag platform
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";

const info = vi.fn();
let dir: string;

const load = async (env: Record<string, string>) => {
  vi.resetModules();
  info.mockClear();
  vi.doMock("../../utils/logger.js", () => ({ logger: { info } }));
  vi.stubEnv("UI_CLIENT_ID", "");
  vi.stubEnv("UI_DIST_PATH", dir);
  vi.stubEnv("TEREO_URL", "https://tereo.example.com");
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  return (await import("../../ui/config.js")).uiEnabled;
};

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "zeteo-ui-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.doUnmock("../../utils/logger.js");
});

describe("uiEnabled", () => {
  it("is true with a client id and a build, logging once", async () => {
    writeFileSync(path.join(dir, "index.html"), "<html></html>");
    const uiEnabled = await load({ UI_CLIENT_ID: "zeteo-ui" });
    expect([uiEnabled(), uiEnabled(), uiEnabled()]).toEqual([true, true, true]);
    expect(info).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledWith("admin UI served");
  });

  it("is false without UI_CLIENT_ID, even with a build", async () => {
    writeFileSync(path.join(dir, "index.html"), "<html></html>");
    const uiEnabled = await load({});
    expect([uiEnabled(), uiEnabled()]).toEqual([false, false]);
    expect(info).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledWith(
      { reason: "no UI_CLIENT_ID" },
      "admin UI not served"
    );
  });

  it("is false when the directory has no index.html", async () => {
    const uiEnabled = await load({ UI_CLIENT_ID: "zeteo-ui" });
    expect([uiEnabled(), uiEnabled()]).toEqual([false, false]);
    expect(info).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledWith(
      { reason: "no build" },
      "admin UI not served"
    );
  });
});
