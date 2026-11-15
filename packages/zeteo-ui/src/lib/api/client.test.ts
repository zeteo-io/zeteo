import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AxiosError, type InternalAxiosRequestConfig } from "axios";
import type { Tokens } from "@/lib/auth";

// The real token store and the real single-flight renew run; only the sign-in
// redirect and the configuration are replaced.
const startLogin = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("@/lib/auth", async () => ({
  ...(await vi.importActual<typeof import("@/lib/auth")>("@/lib/auth")),
  startLogin,
}));
vi.mock("@/lib/config", () => ({
  loadConfig: async () => ({ tereoUrl: "https://tereo.test", clientId: "c" }),
}));

const tokens = (accessToken: string, expiresAt: number): Tokens => ({
  accessToken,
  refreshToken: "refresh-1",
  idToken: "id",
  expiresAt,
});

type Handler = (config: InternalAxiosRequestConfig) => number;

const load = async () => {
  vi.resetModules();
  const auth = await import("@/lib/auth");
  const { api } = await import("./client");
  return { auth, api };
};

const stubAdapter = (
  api: { defaults: { adapter?: unknown } },
  handler: Handler,
  seen: InternalAxiosRequestConfig[] = []
) => {
  api.defaults.adapter = async (config: InternalAxiosRequestConfig) => {
    seen.push(config);
    const status = handler(config);
    const response = {
      status,
      statusText: "",
      data: { ok: status < 400 },
      headers: {},
      config,
    };
    if (status >= 400) {
      throw new AxiosError("x", "ERR_BAD_REQUEST", config, null, response);
    }
    return response;
  };
};

const authHeader = (config: InternalAxiosRequestConfig) =>
  config.headers.get("Authorization");

describe("api client", () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    startLogin.mockClear();
    fetchMock.mockReset().mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            access_token: "new",
            refresh_token: "refresh-2",
            id_token: "id",
            expires_in: 3600,
          }),
          { status: 200 }
        )
    );
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("attaches the bearer token on the page's origin", async () => {
    const { auth, api } = await load();
    auth.setTokens(tokens("old", Date.now() + 3_600_000));
    const seen: InternalAxiosRequestConfig[] = [];
    stubAdapter(api, () => 200, seen);
    await api.get("/v1/sources");
    expect(authHeader(seen[0])).toBe("Bearer old");
  });

  it("renews once for three simultaneous 401s and repeats each once", async () => {
    const { auth, api } = await load();
    auth.setTokens(tokens("old", Date.now() + 3_600_000));
    const seen: InternalAxiosRequestConfig[] = [];
    stubAdapter(
      api,
      (config) => (authHeader(config) === "Bearer old" ? 401 : 200),
      seen
    );

    const results = await Promise.all([
      api.get("/v1/a"),
      api.get("/v1/b"),
      api.get("/v1/c"),
    ]);

    expect(results.map((r) => r.status)).toEqual([200, 200, 200]);
    const renewals = fetchMock.mock.calls.filter(([url]) =>
      String(url).endsWith("/oauth/token")
    );
    expect(renewals).toHaveLength(1);
    expect(seen).toHaveLength(6);
    expect(seen.filter((c) => authHeader(c) === "Bearer new")).toHaveLength(3);
    expect(startLogin).not.toHaveBeenCalled();
  });

  it("starts sign-in once and rejects when the repeat is 401 too", async () => {
    const { auth, api } = await load();
    auth.setTokens(tokens("old", Date.now() + 3_600_000));
    const seen: InternalAxiosRequestConfig[] = [];
    stubAdapter(api, () => 401, seen);

    const settled = await Promise.allSettled([
      api.get("/v1/a"),
      api.get("/v1/b"),
    ]);

    expect(settled.map((s) => s.status)).toEqual(["rejected", "rejected"]);
    expect(seen).toHaveLength(4);
    expect(startLogin).toHaveBeenCalledTimes(1);
  });

  it("starts sign-in and rejects when the renewal fails", async () => {
    const { auth, api } = await load();
    auth.setTokens(tokens("old", Date.now() + 3_600_000));
    fetchMock.mockImplementation(
      async () =>
        new Response(JSON.stringify({ error: "invalid_grant" }), {
          status: 400,
        })
    );
    stubAdapter(api, () => 401);
    await expect(api.get("/v1/a")).rejects.toBeDefined();
    expect(startLogin).toHaveBeenCalledTimes(1);
  });

  it("rejects with an ApiError and keeps the session when renewal fails transiently", async () => {
    const { auth, api } = await load();
    auth.setTokens(tokens("old", Date.now() + 3_600_000));
    fetchMock.mockImplementation(
      async () =>
        new Response(JSON.stringify({ error: "temporarily_unavailable" }), {
          status: 503,
        })
    );
    stubAdapter(api, () => 401);
    await expect(api.get("/v1/a")).rejects.toMatchObject({
      code: "temporarily_unavailable",
    });
    expect(startLogin).not.toHaveBeenCalled();
    expect(auth.getTokens()).not.toBeNull();
  });

  it("starts a silent sign-in once when Tereo refuses the refresh token", async () => {
    const { auth, api } = await load();
    auth.setTokens(tokens("old", Date.now() + 3_600_000));
    fetchMock.mockImplementation(
      async () =>
        new Response(JSON.stringify({ error: "invalid_grant" }), {
          status: 400,
        })
    );
    stubAdapter(api, () => 401);
    await Promise.allSettled([api.get("/v1/a"), api.get("/v1/b")]);
    expect(startLogin).toHaveBeenCalledTimes(1);
    expect(startLogin).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ silent: true })
    );
  });

  it("surfaces a failed sign-in start and allows another attempt", async () => {
    const { auth, api } = await load();
    auth.setTokens(tokens("old", Date.now() + 3_600_000));
    startLogin.mockRejectedValueOnce(new Error("no crypto"));
    stubAdapter(api, () => 401);
    await expect(api.get("/v1/a")).rejects.toMatchObject({
      message: "no crypto",
    });
    await expect(api.get("/v1/a")).rejects.toBeDefined();
    expect(startLogin).toHaveBeenCalledTimes(2);
  });

  it("repeats a late 401 with the current token and no renewal", async () => {
    const { auth, api } = await load();
    auth.setTokens(tokens("old", Date.now() + 3_600_000));
    const seen: InternalAxiosRequestConfig[] = [];
    stubAdapter(
      api,
      (config) => {
        if (authHeader(config) === "Bearer old") {
          // Another request's renewal finished while this one was in flight.
          auth.setTokens(tokens("fresh", Date.now() + 3_600_000));
          return 401;
        }
        return 200;
      },
      seen
    );
    const res = await api.get("/v1/a");
    expect(res.status).toBe(200);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(authHeader(seen[1])).toBe("Bearer fresh");
  });

  it("replays a POST body once, unchanged", async () => {
    const { auth, api } = await load();
    auth.setTokens(tokens("old", Date.now() + 3_600_000));
    const seen: InternalAxiosRequestConfig[] = [];
    stubAdapter(
      api,
      (config) => (authHeader(config) === "Bearer old" ? 401 : 200),
      seen
    );
    await api.post("/v1/sources", { name: "x", n: 1 });
    expect(seen).toHaveLength(2);
    expect(seen[0].data).toBe(seen[1].data);
    expect(JSON.parse(seen[1].data)).toEqual({ name: "x", n: 1 });
  });

  it("renews first when the token expires within 60 s", async () => {
    const { auth, api } = await load();
    auth.setTokens(tokens("old", Date.now() + 30_000));
    const seen: InternalAxiosRequestConfig[] = [];
    stubAdapter(api, () => 200, seen);
    await api.get("/v1/a");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(seen).toHaveLength(1);
    expect(authHeader(seen[0])).toBe("Bearer new");
  });

  it("rejects, without starting sign-in, a request waiting on a renewal Tereo never answers", async () => {
    vi.useFakeTimers();
    try {
      const { auth, api } = await load();
      auth.setTokens(tokens("old", Date.now() - 1));
      fetchMock.mockReturnValue(new Promise<Response>(() => {}));
      const seen: InternalAxiosRequestConfig[] = [];
      stubAdapter(api, () => 200, seen);

      const outcome = api.get("/v1/a").catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(15_000);
      expect(await outcome).toMatchObject({ status: null, code: "timeout" });
      expect(seen).toHaveLength(0);
      expect(startLogin).not.toHaveBeenCalled();
      expect(auth.getTokens()).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails fast, sending nothing and starting no sign-in, while the session-ended notice shows", async () => {
    const { auth, api } = await load();
    auth.setSessionEnded(true);
    const seen: InternalAxiosRequestConfig[] = [];
    stubAdapter(api, () => 200, seen);

    await expect(api.get("/v1/a")).rejects.toMatchObject({
      status: null,
      code: "session_ended",
    });
    expect(seen).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(startLogin).not.toHaveBeenCalled();
  });

  it("does not start sign-in for a 401 that lands after the session-ended notice shows", async () => {
    const { auth, api } = await load();
    auth.setTokens(tokens("old", Date.now() + 3_600_000));
    stubAdapter(api, () => {
      auth.setTokens(null);
      auth.setSessionEnded(true);
      return 401;
    });

    await expect(api.get("/v1/a")).rejects.toBeDefined();
    expect(startLogin).not.toHaveBeenCalled();
  });

  it("sends no Authorization header to another origin", async () => {
    const { auth, api } = await load();
    auth.setTokens(tokens("old", Date.now() + 3_600_000));
    const seen: InternalAxiosRequestConfig[] = [];
    stubAdapter(api, () => 200, seen);
    await api.get("https://elsewhere.test/v1/a");
    await api.get("//other.example/x");
    expect(authHeader(seen[0])).toBeFalsy();
    expect(authHeader(seen[1])).toBeFalsy();
  });
});
