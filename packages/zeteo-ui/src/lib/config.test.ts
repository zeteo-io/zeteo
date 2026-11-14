import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { jsonResponse } from "@/test/oauthFixtures";

// loadConfig caches its answer for the page's life: a fresh module per test.
const load = async () => import("./config");

describe("loadConfig", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.resetModules();
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reads /ui-config.json from the page's origin", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, {
        tereo_url: "https://tereo.example.com/",
        client_id: "zeteo-ui",
      })
    );
    const { loadConfig } = await load();

    await expect(loadConfig()).resolves.toEqual({
      tereoUrl: "https://tereo.example.com",
      clientId: "zeteo-ui",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "/ui-config.json",
      expect.objectContaining({ credentials: "same-origin" })
    );
  });

  it("fetches once however often it is asked", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, { tereo_url: "https://t.example", client_id: "c" })
    );
    const { loadConfig } = await load();

    const [a, b] = await Promise.all([loadConfig(), loadConfig()]);
    await loadConfig();
    expect(a).toEqual(b);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects with a ConfigError naming the status when the answer is not 200", async () => {
    fetchMock.mockResolvedValue(jsonResponse(404, { error: "not_found" }));
    const { loadConfig, ConfigError } = await load();

    const err = await loadConfig().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as Error).message).toMatch(/404/);
  });

  it("rejects with a ConfigError when the request fails", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    const { loadConfig, ConfigError } = await load();

    await expect(loadConfig()).rejects.toBeInstanceOf(ConfigError);
  });

  it.each([
    ["not JSON", new Response("<html>", { status: 200 })],
    ["no client_id", jsonResponse(200, { tereo_url: "https://t.example" })],
    [
      "an empty client_id",
      jsonResponse(200, { tereo_url: "https://t.example", client_id: "" }),
    ],
    ["no tereo_url", jsonResponse(200, { client_id: "c" })],
    [
      "a tereo_url that is not a URL",
      jsonResponse(200, { tereo_url: "tereo", client_id: "c" }),
    ],
    [
      "a tereo_url that is not http(s)",
      jsonResponse(200, { tereo_url: "javascript:alert(1)", client_id: "c" }),
    ],
    ["an array", jsonResponse(200, [])],
  ])("rejects with a ConfigError on %s", async (_name, response) => {
    fetchMock.mockResolvedValue(response);
    const { loadConfig, ConfigError } = await load();

    await expect(loadConfig()).rejects.toBeInstanceOf(ConfigError);
  });
});
