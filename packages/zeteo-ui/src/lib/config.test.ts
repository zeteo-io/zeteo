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

  it.each([
    ["https://tereo.example.com", "https://tereo.example.com"],
    ["https://tereo.example.com/auth/", "https://tereo.example.com/auth"],
    ["HTTPS://Tereo.Example.com:443/", "https://tereo.example.com"],
    ["http://localhost:4001//", "http://localhost:4001"],
  ])(
    "keeps %s as %s (origin and path, no trailing slash)",
    async (raw, kept) => {
      fetchMock.mockResolvedValue(
        jsonResponse(200, { tereo_url: raw, client_id: "c" })
      );
      const { loadConfig } = await load();
      expect((await loadConfig()).tereoUrl).toBe(kept);
    }
  );

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

  it.each<[string, Response]>([
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
    ...(
      [
        ["an ftp tereo_url", "ftp://tereo.example"],
        ["a file tereo_url", "file:///etc/passwd"],
        ["a tereo_url with a user", "https://user@tereo.example"],
        ["a tereo_url with credentials", "https://user:pw@tereo.example"],
        ["a tereo_url with a query", "https://tereo.example/?a=1"],
        ["a tereo_url with a bare ?", "https://tereo.example/?"],
        ["a tereo_url with a fragment", "https://tereo.example/#x"],
        ["a tereo_url with a bare #", "https://tereo.example#"],
      ] as const
    ).map(([name, tereo_url]): [string, Response] => [
      name,
      jsonResponse(200, { tereo_url, client_id: "c" }),
    ]),
  ])("rejects with a ConfigError on %s", async (_name, response) => {
    fetchMock.mockResolvedValue(response);
    const { loadConfig, ConfigError } = await load();

    await expect(loadConfig()).rejects.toBeInstanceOf(ConfigError);
  });
});
