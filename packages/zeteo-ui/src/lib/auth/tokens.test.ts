import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { completeLogin, navigation, renew, signOut } from "./oauth";
import { getTokens, setTokens, subscribeTokens } from "./tokens";
import {
  callbackUrl,
  CFG,
  jsonResponse,
  storeLogin,
  tokenBody,
} from "@/test/oauthFixtures";

beforeEach(() => {
  setTokens(null);
  sessionStorage.clear();
  localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("token store", () => {
  it("holds the tokens in memory and tells subscribers", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeTokens(listener);
    const tokens = {
      accessToken: "a",
      refreshToken: "r",
      idToken: "i",
      expiresAt: 1,
    };

    setTokens(tokens);
    expect(getTokens()).toBe(tokens);
    expect(listener).toHaveBeenLastCalledWith(tokens);

    unsubscribe();
    setTokens(null);
    expect(getTokens()).toBeNull();
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe("no token leaves memory", () => {
  it("through a sign-in, a renewal and a sign-out", async () => {
    vi.spyOn(navigation, "assign").mockImplementation(() => {});
    const issued = [
      tokenBody({ suffix: "first" }),
      tokenBody({ suffix: "second" }),
    ];
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(200, issued[0]))
      .mockResolvedValueOnce(jsonResponse(200, issued[1]))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const secrets = issued.flatMap((t) =>
      [t.access_token, t.refresh_token, t.id_token!].flatMap((s) => [
        s,
        // Each JWT segment on its own, in case one is stored split.
        ...s.split(".").filter((part) => part.length > 20),
      ])
    );

    const exposed = () =>
      [
        JSON.stringify({ ...localStorage }),
        JSON.stringify({ ...sessionStorage }),
        document.cookie,
        window.location.href,
      ].join("\n");
    const expectNoSecret = () => {
      const surface = exposed();
      for (const secret of secrets) expect(surface).not.toContain(secret);
    };

    const login = storeLogin();
    await completeLogin(CFG, callbackUrl({ code: "abc", state: login.state }));
    expect(getTokens()?.accessToken).toBe(issued[0].access_token);
    expectNoSecret();

    await renew(CFG);
    expect(getTokens()?.refreshToken).toBe(issued[1].refresh_token);
    expectNoSecret();

    await signOut(CFG);
    expect(getTokens()).toBeNull();
    expectNoSecret();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
