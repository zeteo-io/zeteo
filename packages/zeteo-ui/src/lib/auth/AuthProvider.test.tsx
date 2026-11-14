import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import { ConfigError, loadConfig } from "@/lib/config";
import userEvent from "@testing-library/user-event";
import { getTokens, setTokens } from "./tokens";
import { AuthProvider } from "./AuthProvider";
import { navigation } from "./oauth";
import { useAuth } from "./useAuth";
import { StrictMode } from "react";
import {
  bodyOf,
  CFG,
  jsonResponse,
  exposedSurface,
  LOGIN_KEY,
  secretsOf,
  storeLogin,
  tokenBody,
} from "@/test/oauthFixtures";

vi.mock("@/lib/config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/config")>()),
  loadConfig: vi.fn(),
}));

const ME = {
  id: "6f1c1f0e-4b9a-4c43-9d5e-0c1b7d1a2e3f",
  type: "user",
  name: "Ada Lovelace",
  email: "ada@example.com",
  permissions: ["zeteo.sources.write"],
};

const fetchMock = vi.fn<typeof fetch>();
let assign: ReturnType<typeof vi.spyOn>;
let meAnswers: Array<() => Response>;
let tokenAnswers: Array<() => Response>;
let defaultToken: () => Response;
let tokenTimes: number[];

const callsTo = (url: string) =>
  fetchMock.mock.calls.filter(([u]) => String(u) === url);

const Probe = () => {
  const { me, can, signOut } = useAuth();
  return (
    <div>
      <p>signed in as {me.name}</p>
      <p>{can("zeteo.sources.read") ? "can read sources" : "cannot"}</p>
      <button onClick={signOut}>probe sign out</button>
    </div>
  );
};

const renderAt = (path: string) => {
  window.history.replaceState(null, "", path);
  return render(
    <StrictMode>
      <AuthProvider>
        <Probe />
      </AuthProvider>
    </StrictMode>
  );
};

const lastNavigation = () =>
  new URL(String(assign.mock.calls[assign.mock.calls.length - 1][0]));

beforeEach(() => {
  setTokens(null);
  sessionStorage.clear();
  vi.mocked(loadConfig).mockReset().mockResolvedValue(CFG);
  meAnswers = [];
  tokenAnswers = [];
  defaultToken = () => jsonResponse(200, tokenBody());
  tokenTimes = [];
  fetchMock.mockReset().mockImplementation(async (input) => {
    const url = String(input);
    if (url === "/v1/me")
      return (meAnswers.shift() ?? (() => jsonResponse(200, ME)))();
    if (url === `${CFG.tereoUrl}/oauth/token`) {
      tokenTimes.push(Date.now());
      return (tokenAnswers.shift() ?? defaultToken)();
    }
    if (url === `${CFG.tereoUrl}/oauth/revoke`)
      return new Response(null, { status: 200 });
    throw new Error(`unexpected request to ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  assign = vi.spyOn(navigation, "assign").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  Reflect.deleteProperty(window, "isSecureContext");
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.history.replaceState(null, "", "/");
});

describe("AuthProvider", () => {
  it("starts a silent login, once, when there is no token", async () => {
    renderAt("/sources?tab=tables");

    await waitFor(() => expect(assign).toHaveBeenCalled());
    expect(assign).toHaveBeenCalledTimes(1);
    expect(lastNavigation().searchParams.get("prompt")).toBe("none");
    expect(JSON.parse(sessionStorage.getItem(LOGIN_KEY)!).returnTo).toBe(
      "/sources?tab=tables"
    );
    expect(screen.queryByText(/signed in as/)).not.toBeInTheDocument();
  });

  it("moves to an interactive login, once, when the silent one answers login_required", async () => {
    const login = storeLogin({ returnTo: "/runs" });
    renderAt(`/callback?error=login_required&state=${login.state}`);

    await waitFor(() => expect(assign).toHaveBeenCalled());
    // Let a second, unwanted redirect show itself.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(assign).toHaveBeenCalledTimes(1);
    const url = lastNavigation();
    expect(url.pathname).toBe("/oauth/authorize");
    expect(url.searchParams.has("prompt")).toBe(false);
    expect(JSON.parse(sessionStorage.getItem(LOGIN_KEY)!).returnTo).toBe(
      "/runs"
    );
  });

  it.each(["interaction_required", "consent_required"])(
    "treats %s like login_required",
    async (error) => {
      const login = storeLogin();
      renderAt(`/callback?error=${error}&state=${login.state}`);
      await waitFor(() => expect(assign).toHaveBeenCalledTimes(1));
      expect(lastNavigation().searchParams.has("prompt")).toBe(false);
    }
  );

  it("shows SignedOut with the error, not a redirect, for any other callback error", async () => {
    const login = storeLogin();
    renderAt(`/callback?error=access_denied&state=${login.state}`);

    expect(await screen.findByText(/access_denied/)).toBeInTheDocument();
    expect(assign).not.toHaveBeenCalled();
    expect(window.location.search).toBe("");

    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() => expect(assign).toHaveBeenCalledTimes(1));
    expect(lastNavigation().searchParams.has("prompt")).toBe(false);
  });

  it("shows SignedOut for a callback with no login in progress", async () => {
    renderAt("/callback?error=login_required&state=bookmarked");

    expect(await screen.findByText(/no_login_state/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign in" })).toBeInTheDocument();
    expect(assign).not.toHaveBeenCalled();
  });

  it("exchanges the code once, cleans the address bar and renders the app", async () => {
    const login = storeLogin({ returnTo: "/grants?page=2" });
    const body = tokenBody();
    tokenAnswers.push(() => jsonResponse(200, body));
    renderAt(`/callback?code=the-code&state=${login.state}`);

    expect(
      await screen.findByText("signed in as Ada Lovelace")
    ).toBeInTheDocument();
    expect(screen.getByText("can read sources")).toBeInTheDocument();
    expect(callsTo(`${CFG.tereoUrl}/oauth/token`)).toHaveLength(1);
    expect(window.location.href).not.toContain("code=");
    expect(window.location.href).not.toContain("state=");
    expect(`${window.location.pathname}${window.location.search}`).toBe(
      "/grants?page=2"
    );

    const [, init] = callsTo("/v1/me")[0];
    expect(new Headers(init?.headers).get("authorization")).toBe(
      `Bearer ${body.access_token}`
    );
    expect(assign).not.toHaveBeenCalled();
  });

  it("shows NoAccess, with the person's name and a sign-out, to someone with no permission", async () => {
    const login = storeLogin();
    meAnswers.push(() => jsonResponse(200, { ...ME, permissions: [] }));
    renderAt(`/callback?code=c2&state=${login.state}`);

    expect(await screen.findByText(/Ada Lovelace/)).toBeInTheDocument();
    expect(screen.getByText(/no zeteo admin permission/i)).toBeInTheDocument();
    expect(screen.queryByText(/signed in as/)).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Sign out" }));
    await waitFor(() => expect(assign).toHaveBeenCalledTimes(1));
    expect(lastNavigation().pathname).toBe("/oauth/end-session");
    expect(callsTo(`${CFG.tereoUrl}/oauth/revoke`)).toHaveLength(1);
    expect(getTokens()).toBeNull();
  });

  it("shows an error page that names the problem when /ui-config.json fails, and starts no login", async () => {
    vi.mocked(loadConfig).mockRejectedValue(
      new ConfigError("/ui-config.json answered 404")
    );
    renderAt("/");

    expect(
      await screen.findByText(/\/ui-config\.json answered 404/)
    ).toBeInTheDocument();
    expect(assign).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("renews once and retries when /v1/me answers 401", async () => {
    const login = storeLogin();
    meAnswers.push(() => jsonResponse(401, { error: "unauthorized" }));
    tokenAnswers.push(
      () => jsonResponse(200, tokenBody({ suffix: "1" })),
      () => jsonResponse(200, tokenBody({ suffix: "2" }))
    );
    renderAt(`/callback?code=c3&state=${login.state}`);

    expect(
      await screen.findByText("signed in as Ada Lovelace")
    ).toBeInTheDocument();
    expect(callsTo(`${CFG.tereoUrl}/oauth/token`)).toHaveLength(2);
    expect(callsTo("/v1/me")).toHaveLength(2);
  });

  it("shows an error page when /v1/me fails", async () => {
    const login = storeLogin();
    meAnswers.push(() => jsonResponse(500, { error: "internal" }));
    renderAt(`/callback?code=c4&state=${login.state}`);

    expect(await screen.findByText(/500/)).toBeInTheDocument();
    expect(screen.queryByText(/signed in as/)).not.toBeInTheDocument();
  });

  it("renews 60 seconds before the access token expires", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const login = storeLogin();
    tokenAnswers.push(
      () => jsonResponse(200, tokenBody({ suffix: "1", expiresIn: 120 })),
      () => jsonResponse(200, tokenBody({ suffix: "2", expiresIn: 120 }))
    );
    renderAt(`/callback?code=c5&state=${login.state}`);
    expect(
      await screen.findByText("signed in as Ada Lovelace")
    ).toBeInTheDocument();
    expect(callsTo(`${CFG.tereoUrl}/oauth/token`)).toHaveLength(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(55_000);
    });
    expect(callsTo(`${CFG.tereoUrl}/oauth/token`)).toHaveLength(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(6_000);
    });
    const renewals = callsTo(`${CFG.tereoUrl}/oauth/token`);
    expect(renewals).toHaveLength(2);
    expect(bodyOf(renewals[1][1]).grant_type).toBe("refresh_token");
    expect(getTokens()?.refreshToken).toBe(
      tokenBody({ suffix: "2" }).refresh_token
    );
  });

  it("starts a silent login when a scheduled renewal is refused", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const login = storeLogin({ returnTo: "/sources" });
    tokenAnswers.push(
      () => jsonResponse(200, tokenBody({ suffix: "1", expiresIn: 61 })),
      () => jsonResponse(400, { error: "invalid_grant" })
    );
    renderAt(`/callback?code=c6&state=${login.state}`);
    expect(
      await screen.findByText("signed in as Ada Lovelace")
    ).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(31_000);
    });
    await waitFor(() => expect(assign).toHaveBeenCalledTimes(1));
    expect(lastNavigation().searchParams.get("prompt")).toBe("none");
    expect(JSON.parse(sessionStorage.getItem(LOGIN_KEY)!).returnTo).toBe(
      "/sources"
    );
  });

  it("signs out through useAuth and stops renewing", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const login = storeLogin();
    tokenAnswers.push(() =>
      jsonResponse(200, tokenBody({ suffix: "1", expiresIn: 120 }))
    );
    renderAt(`/callback?code=c7&state=${login.state}`);
    expect(
      await screen.findByText("signed in as Ada Lovelace")
    ).toBeInTheDocument();

    await userEvent.click(
      screen.getByRole("button", { name: "probe sign out" })
    );
    await waitFor(() => expect(assign).toHaveBeenCalledTimes(1));
    expect(lastNavigation().pathname).toBe("/oauth/end-session");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000);
    });
    expect(callsTo(`${CFG.tereoUrl}/oauth/token`)).toHaveLength(1);
    expect(assign).toHaveBeenCalledTimes(1);
  });

  it("keeps no token outside memory after the callback and after a renewal", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    localStorage.clear();
    const issued = [
      tokenBody({ suffix: "cb", expiresIn: 120 }),
      tokenBody({ suffix: "renewed", expiresIn: 120 }),
    ];
    tokenAnswers.push(
      () => jsonResponse(200, issued[0]),
      () => jsonResponse(200, issued[1])
    );
    const secrets = secretsOf(issued);
    const login = storeLogin({ returnTo: "/sources" });
    renderAt(`/callback?code=c8&state=${login.state}`);

    expect(
      await screen.findByText("signed in as Ada Lovelace")
    ).toBeInTheDocument();
    for (const secret of secrets)
      expect(exposedSurface()).not.toContain(secret);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(61_000);
    });
    expect(getTokens()?.refreshToken).toBe(issued[1].refresh_token);
    for (const secret of secrets)
      expect(exposedSurface()).not.toContain(secret);
  });

  it("renews a 30-second token about every 15 seconds, never back to back", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    defaultToken = () => jsonResponse(200, tokenBody({ expiresIn: 30 }));
    const login = storeLogin();
    renderAt(`/callback?code=c9&state=${login.state}`);
    expect(
      await screen.findByText("signed in as Ada Lovelace")
    ).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(300_000);
    });

    const renewals = tokenTimes.length - 1;
    expect(renewals).toBeGreaterThanOrEqual(15);
    expect(renewals).toBeLessThanOrEqual(22);
    for (let i = 1; i < tokenTimes.length; i++) {
      expect(tokenTimes[i] - tokenTimes[i - 1]).toBeGreaterThanOrEqual(5_000);
    }
    expect(assign).not.toHaveBeenCalled();
  });

  it("starts one sign-in, not a loop, when a 30-second token's renewal is refused", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    tokenAnswers.push(() => jsonResponse(200, tokenBody({ expiresIn: 30 })));
    defaultToken = () => jsonResponse(400, { error: "invalid_grant" });
    const login = storeLogin();
    renderAt(`/callback?code=c10&state=${login.state}`);
    expect(
      await screen.findByText("signed in as Ada Lovelace")
    ).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(300_000);
    });

    expect(tokenTimes).toHaveLength(2);
    expect(assign).toHaveBeenCalledTimes(1);
    expect(lastNavigation().searchParams.get("prompt")).toBe("none");
  });

  it("retries a renewal Tereo keeps refusing with 429 on a bounded cadence, keeping the session", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    tokenAnswers.push(() => jsonResponse(200, tokenBody({ expiresIn: 30 })));
    defaultToken = () => jsonResponse(429, { error: "too_many_requests" });
    const login = storeLogin();
    renderAt(`/callback?code=c11&state=${login.state}`);
    expect(
      await screen.findByText("signed in as Ada Lovelace")
    ).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(300_000);
    });

    expect(tokenTimes.length - 1).toBeLessThanOrEqual(61);
    for (let i = 1; i < tokenTimes.length; i++) {
      expect(tokenTimes[i] - tokenTimes[i - 1]).toBeGreaterThanOrEqual(5_000);
    }
    expect(getTokens()).not.toBeNull();
    expect(assign).not.toHaveBeenCalled();
  });

  it("explains that sign-in needs https when the page is not a secure context", async () => {
    Object.defineProperty(window, "isSecureContext", {
      value: false,
      configurable: true,
    });
    renderAt("/");

    expect(
      await screen.findByText(
        "Sign-in needs https (or localhost): this page was opened over plain http."
      )
    ).toBeInTheDocument();
    expect(assign).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(LOGIN_KEY)).toBeNull();
  });
});
