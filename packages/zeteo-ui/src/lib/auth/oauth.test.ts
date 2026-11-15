import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getTokens, setTokens, type Tokens } from "./tokens";
import { challengeFor } from "./pkce";
import {
  bodyOf,
  callbackUrl,
  CFG,
  jsonResponse,
  LOGIN_KEY,
  storeLogin,
  tokenBody,
} from "@/test/oauthFixtures";
import {
  AuthError,
  completeLogin,
  navigation,
  renew,
  safeReturnTo,
  signOut,
  startLogin,
} from "./oauth";

const fetchMock = vi.fn<typeof fetch>();
let assign: ReturnType<typeof vi.spyOn>;

const navigatedTo = (): URL => {
  expect(assign).toHaveBeenCalledTimes(1);
  return new URL(String(assign.mock.calls[0][0]));
};

const someTokens = (over: Partial<Tokens> = {}): Tokens => ({
  accessToken: "at-old",
  refreshToken: "rt-old",
  idToken: "id-old",
  expiresAt: Date.now() + 60_000,
  ...over,
});

let codeSeq = 0;
const nextCode = () => `code-${++codeSeq}`;

beforeEach(() => {
  setTokens(null);
  sessionStorage.clear();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  assign = vi.spyOn(navigation, "assign").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("startLogin", () => {
  it("navigates to Tereo's authorize endpoint with PKCE, state, nonce and the scopes", async () => {
    await startLogin(CFG, { returnTo: "/sources" });

    const url = navigatedTo();
    expect(`${url.origin}${url.pathname}`).toBe(
      "https://tereo.test/oauth/authorize"
    );
    const p = url.searchParams;
    expect(p.get("response_type")).toBe("code");
    expect(p.get("client_id")).toBe("zeteo-ui");
    expect(p.get("redirect_uri")).toBe(`${window.location.origin}/callback`);
    expect(p.get("scope")).toBe("openid profile email offline_access");
    expect(p.get("code_challenge_method")).toBe("S256");
    expect(p.has("prompt")).toBe(false);

    const stored = JSON.parse(sessionStorage.getItem(LOGIN_KEY) ?? "null");
    expect(Object.keys(stored).sort()).toEqual([
      "nonce",
      "returnTo",
      "state",
      "verifier",
    ]);
    expect(stored.returnTo).toBe("/sources");
    expect(p.get("state")).toBe(stored.state);
    expect(p.get("nonce")).toBe(stored.nonce);
    expect(p.get("code_challenge")).toBe(await challengeFor(stored.verifier));
  });

  it.each([
    [
      "outside a secure context",
      () => {
        Object.defineProperty(window, "isSecureContext", {
          value: false,
          configurable: true,
        });
      },
    ],
    [
      "without crypto.subtle",
      () => {
        vi.spyOn(globalThis.crypto, "subtle", "get").mockReturnValue(
          undefined as unknown as SubtleCrypto
        );
      },
    ],
  ])("refuses to start %s, storing nothing", async (_name, arrange) => {
    arrange();
    try {
      const err = await startLogin(CFG).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AuthError);
      expect((err as AuthError).code).toBe("insecure_context");
      expect(assign).not.toHaveBeenCalled();
      expect(sessionStorage.getItem(LOGIN_KEY)).toBeNull();
    } finally {
      Reflect.deleteProperty(window, "isSecureContext");
    }
  });

  it("adds prompt=none only when silent", async () => {
    await startLogin(CFG, { silent: true });
    expect(navigatedTo().searchParams.get("prompt")).toBe("none");
  });

  it("stores only a safe return path", async () => {
    await startLogin(CFG, { returnTo: "https://evil.example/x" });
    expect(JSON.parse(sessionStorage.getItem(LOGIN_KEY)!).returnTo).toBe("/");
  });

  it("makes fresh state and nonce for every login", async () => {
    await startLogin(CFG);
    const first = JSON.parse(sessionStorage.getItem(LOGIN_KEY)!);
    await startLogin(CFG);
    const second = JSON.parse(sessionStorage.getItem(LOGIN_KEY)!);
    expect(second.state).not.toBe(first.state);
    expect(second.nonce).not.toBe(first.nonce);
    expect(second.verifier).not.toBe(first.verifier);
  });
});

describe("safeReturnTo", () => {
  it.each([
    ["/", "/"],
    ["/sources", "/sources"],
    ["/sources/abc?tab=tables#x", "/sources/abc?tab=tables#x"],
    ["//evil.example/x", "/"],
    ["/\\evil.example", "/"],
    ["https://evil.example/", "/"],
    ["javascript:alert(1)", "/"],
    ["sources", "/"],
    ["/\t/evil.example", "/"],
    ["/callback?code=x&state=y", "/"],
    ["", "/"],
    [undefined, "/"],
    [42, "/"],
  ])("%j → %j", (input, expected) => {
    expect(safeReturnTo(input)).toBe(expected);
  });
});

describe("completeLogin", () => {
  it("exchanges the code with the verifier, as a public client, without cookies", async () => {
    const login = storeLogin({ returnTo: "/grants" });
    const body = tokenBody();
    fetchMock.mockResolvedValue(jsonResponse(200, body));
    const code = nextCode();

    const before = Date.now();
    const result = await completeLogin(
      CFG,
      callbackUrl({ code, state: login.state })
    );

    expect(result).toEqual({ returnTo: "/grants" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://tereo.test/oauth/token");
    expect(init?.method).toBe("POST");
    expect(init?.credentials).toBe("omit");
    expect(new Headers(init?.headers).get("content-type")).toBe(
      "application/x-www-form-urlencoded"
    );
    expect(bodyOf(init)).toEqual({
      grant_type: "authorization_code",
      code,
      redirect_uri: `${window.location.origin}/callback`,
      client_id: "zeteo-ui",
      code_verifier: login.verifier,
    });

    const tokens = getTokens();
    expect(tokens).toMatchObject({
      accessToken: body.access_token,
      refreshToken: body.refresh_token,
      idToken: body.id_token,
    });
    expect(tokens!.expiresAt).toBeGreaterThanOrEqual(before + 900_000);
    expect(tokens!.expiresAt).toBeLessThanOrEqual(Date.now() + 900_000);
    expect(sessionStorage.getItem(LOGIN_KEY)).toBeNull();
  });

  it("accepts an aud array that contains the client id", async () => {
    const login = storeLogin();
    fetchMock.mockResolvedValue(
      jsonResponse(200, tokenBody({ aud: ["other", "zeteo-ui"] }))
    );
    await completeLogin(
      CFG,
      callbackUrl({ code: nextCode(), state: login.state })
    );
    expect(getTokens()).not.toBeNull();
  });

  it("exchanges a code once when asked twice (StrictMode runs effects twice)", async () => {
    const login = storeLogin();
    fetchMock.mockResolvedValue(jsonResponse(200, tokenBody()));
    const url = callbackUrl({ code: nextCode(), state: login.state });

    const [a, b] = await Promise.all([
      completeLogin(CFG, url),
      completeLogin(CFG, url),
    ]);
    expect(a).toEqual(b);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  const rejects = async (url: URL, code: string) => {
    const err = await completeLogin(CFG, url).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AuthError);
    expect((err as AuthError).code).toBe(code);
    expect(getTokens()).toBeNull();
  };

  it("rejects a state mismatch without exchanging or storing", async () => {
    storeLogin();
    await rejects(
      callbackUrl({ code: nextCode(), state: "forged" }),
      "state_mismatch"
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a nonce mismatch without storing tokens", async () => {
    const login = storeLogin();
    fetchMock.mockResolvedValue(
      jsonResponse(200, tokenBody({ nonce: "other" }))
    );
    await rejects(
      callbackUrl({ code: nextCode(), state: login.state }),
      "nonce_mismatch"
    );
  });

  it.each([["someone-else"], [["someone-else", "zeteo"]]])(
    "rejects an ID token whose aud is %j",
    async (aud) => {
      const login = storeLogin();
      fetchMock.mockResolvedValue(jsonResponse(200, tokenBody({ aud })));
      await rejects(
        callbackUrl({ code: nextCode(), state: login.state }),
        "audience_mismatch"
      );
    }
  );

  it("rejects a token answer without an ID token", async () => {
    const login = storeLogin();
    fetchMock.mockResolvedValue(
      jsonResponse(200, tokenBody({ idToken: false }))
    );
    await rejects(
      callbackUrl({ code: nextCode(), state: login.state }),
      "invalid_token_response"
    );
  });

  it("rejects an ID token that cannot be read", async () => {
    const login = storeLogin();
    fetchMock.mockResolvedValue(
      jsonResponse(200, { ...tokenBody(), id_token: "not-a-jwt" })
    );
    await rejects(
      callbackUrl({ code: nextCode(), state: login.state }),
      "invalid_id_token"
    );
  });

  it("rejects when the token endpoint refuses, with its error code", async () => {
    const login = storeLogin();
    fetchMock.mockResolvedValue(
      jsonResponse(400, { error: "invalid_grant", error_description: "x" })
    );
    await rejects(
      callbackUrl({ code: nextCode(), state: login.state }),
      "invalid_grant"
    );
  });

  it("gives up on a code exchange Tereo never answers after 15 seconds", async () => {
    vi.useFakeTimers();
    try {
      const login = storeLogin();
      fetchMock.mockReturnValue(new Promise<Response>(() => {}));
      const url = callbackUrl({ code: nextCode(), state: login.state });
      const outcome = completeLogin(CFG, url).catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(15_000);
      const err = await outcome;
      expect(err).toBeInstanceOf(AuthError);
      expect((err as AuthError).code).toBe("timeout");
      expect(getTokens()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects a callback with no stored login", async () => {
    await rejects(
      callbackUrl({ code: nextCode(), state: "s" }),
      "no_login_state"
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports the authorization error with the stored return path", async () => {
    const login = storeLogin({ returnTo: "/runs" });
    const err = (await completeLogin(
      CFG,
      callbackUrl({ error: "login_required", state: login.state })
    ).catch((e: unknown) => e)) as AuthError;
    expect(err).toBeInstanceOf(AuthError);
    expect(err.code).toBe("login_required");
    expect(err.returnTo).toBe("/runs");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(LOGIN_KEY)).toBeNull();
  });

  it("does not hand a return path to an error whose state does not match", async () => {
    storeLogin();
    const err = (await completeLogin(
      CFG,
      callbackUrl({ error: "login_required", state: "forged" })
    ).catch((e: unknown) => e)) as AuthError;
    expect(err.code).toBe("state_mismatch");
    expect(err.returnTo).toBeUndefined();
  });
});

describe("renew", () => {
  it("sends the refresh token as a public client and stores the rotated one", async () => {
    setTokens(someTokens());
    const body = tokenBody({ suffix: "2" });
    fetchMock.mockResolvedValue(jsonResponse(200, body));

    const tokens = await renew(CFG);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://tereo.test/oauth/token");
    expect(init?.credentials).toBe("omit");
    expect(bodyOf(init)).toEqual({
      grant_type: "refresh_token",
      refresh_token: "rt-old",
      client_id: "zeteo-ui",
    });
    expect(tokens).toMatchObject({
      accessToken: body.access_token,
      refreshToken: body.refresh_token,
      idToken: body.id_token,
    });
    expect(getTokens()).toEqual(tokens);
  });

  it("keeps the ID token when the renewal does not return one", async () => {
    setTokens(someTokens());
    fetchMock.mockResolvedValue(
      jsonResponse(200, tokenBody({ suffix: "2", idToken: false }))
    );
    expect((await renew(CFG)).idToken).toBe("id-old");
  });

  it("shares one request between concurrent callers", async () => {
    setTokens(someTokens());
    let answer!: (r: Response) => void;
    fetchMock.mockReturnValue(new Promise((r) => (answer = r)));

    const a = renew(CFG);
    const b = renew(CFG);
    answer(jsonResponse(200, tokenBody({ suffix: "2" })));

    const [ta, tb] = await Promise.all([a, b]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(ta).toBe(tb);

    fetchMock.mockResolvedValue(jsonResponse(200, tokenBody({ suffix: "3" })));
    await renew(CFG);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(bodyOf(fetchMock.mock.calls[1][1]).refresh_token).toBe(
      ta.refreshToken
    );
  });

  it("clears the tokens and rejects on a 400", async () => {
    setTokens(someTokens());
    fetchMock.mockResolvedValue(jsonResponse(400, { error: "invalid_grant" }));

    const err = await renew(CFG).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AuthError);
    expect((err as AuthError).code).toBe("invalid_grant");
    expect(getTokens()).toBeNull();
  });

  it.each([[401, "invalid_client"]])(
    "clears the tokens on a %i",
    async (status, error) => {
      setTokens(someTokens());
      fetchMock.mockResolvedValue(jsonResponse(status, { error }));
      await expect(renew(CFG)).rejects.toBeInstanceOf(AuthError);
      expect(getTokens()).toBeNull();
    }
  );

  it.each([
    [429, "too_many_requests"],
    [403, "forbidden"],
    [500, "server_error"],
    [503, "temporarily_unavailable"],
  ])("keeps the tokens and rejects on a %i", async (status, error) => {
    const held = someTokens();
    setTokens(held);
    fetchMock.mockResolvedValue(jsonResponse(status, { error }));

    const err = await renew(CFG).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AuthError);
    expect((err as AuthError).code).toBe(error);
    expect(getTokens()).toBe(held);
  });

  it("keeps the tokens when Tereo cannot be reached", async () => {
    const held = someTokens();
    setTokens(held);
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));

    await expect(renew(CFG)).rejects.toBeInstanceOf(AuthError);
    expect(getTokens()).toBe(held);
  });

  it("gives up on a refresh Tereo never answers after 15 seconds, keeping the tokens", async () => {
    vi.useFakeTimers();
    try {
      const held = someTokens();
      setTokens(held);
      let aborted = false;
      fetchMock.mockImplementation(
        (_url, init) =>
          new Promise<Response>(() => {
            init?.signal?.addEventListener("abort", () => (aborted = true));
          })
      );

      const outcomes: unknown[] = [];
      const a = renew(CFG).catch((e: unknown) => outcomes.push(e));
      const b = renew(CFG).catch((e: unknown) => outcomes.push(e));
      await vi.advanceTimersByTimeAsync(14_900);
      expect(outcomes).toHaveLength(0);

      await vi.advanceTimersByTimeAsync(200);
      await Promise.all([a, b]);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(outcomes).toHaveLength(2);
      for (const err of outcomes) {
        expect(err).toBeInstanceOf(AuthError);
        expect((err as AuthError).code).toBe("timeout");
      }
      expect(aborted).toBe(true);
      expect(getTokens()).toBe(held);

      // The next renewal is a fresh attempt, not the hung one.
      fetchMock.mockResolvedValue(
        jsonResponse(200, tokenBody({ suffix: "2" }))
      );
      await expect(renew(CFG)).resolves.toMatchObject({
        refreshToken: tokenBody({ suffix: "2" }).refresh_token,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects without a request when signed out", async () => {
    await expect(renew(CFG)).rejects.toBeInstanceOf(AuthError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not bring back tokens cleared while it was in flight", async () => {
    setTokens(someTokens());
    let answer!: (r: Response) => void;
    fetchMock.mockReturnValue(new Promise((r) => (answer = r)));

    const pending = renew(CFG);
    setTokens(null);
    answer(jsonResponse(200, tokenBody({ suffix: "2" })));

    await expect(pending).rejects.toBeInstanceOf(AuthError);
    expect(getTokens()).toBeNull();
  });
});

describe("signOut", () => {
  it("revokes the refresh token, clears the tokens, then ends the session at Tereo", async () => {
    setTokens(someTokens());
    fetchMock.mockImplementation(async () => {
      expect(assign).not.toHaveBeenCalled();
      return new Response(null, { status: 200 });
    });

    await signOut(CFG);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://tereo.test/oauth/revoke");
    expect(init?.credentials).toBe("omit");
    expect(bodyOf(init)).toEqual({
      token: "rt-old",
      token_type_hint: "refresh_token",
      client_id: "zeteo-ui",
    });
    expect(getTokens()).toBeNull();

    const end = navigatedTo();
    expect(`${end.origin}${end.pathname}`).toBe(
      "https://tereo.test/oauth/end-session"
    );
    expect(end.searchParams.get("id_token_hint")).toBe("id-old");
    expect(end.searchParams.get("client_id")).toBe("zeteo-ui");
    expect(end.searchParams.get("post_logout_redirect_uri")).toBe(
      `${window.location.origin}/`
    );
  });

  it("gives up on a revoke that hangs after 5 seconds and still ends the session", async () => {
    vi.useFakeTimers();
    try {
      setTokens(someTokens());
      let aborted = false;
      fetchMock.mockImplementation(
        (_url, init) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => {
              aborted = true;
              reject(new DOMException("aborted", "AbortError"));
            });
          })
      );

      let done = false;
      const out = signOut(CFG).then(() => (done = true));
      await vi.advanceTimersByTimeAsync(4_900);
      expect(done).toBe(false);
      expect(assign).not.toHaveBeenCalled();
      expect(getTokens()).toBeNull();

      await vi.advanceTimersByTimeAsync(200);
      await out;
      expect(aborted).toBe(true);
      expect(navigatedTo().pathname).toBe("/oauth/end-session");
    } finally {
      vi.useRealTimers();
    }
  });

  it("ends the session after 5 seconds even when the revoke ignores the abort", async () => {
    vi.useFakeTimers();
    try {
      setTokens(someTokens());
      fetchMock.mockReturnValue(new Promise<Response>(() => {}));

      const out = signOut(CFG);
      await vi.advanceTimersByTimeAsync(5_000);
      await out;
      expect(navigatedTo().pathname).toBe("/oauth/end-session");
    } finally {
      vi.useRealTimers();
    }
  });

  it("still clears the tokens and ends the session when the revoke fails", async () => {
    setTokens(someTokens());
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));

    await signOut(CFG);

    expect(getTokens()).toBeNull();
    expect(navigatedTo().pathname).toBe("/oauth/end-session");
  });

  it("waits for a renewal in flight and revokes the rotated refresh token", async () => {
    setTokens(someTokens());
    let answer!: (r: Response) => void;
    fetchMock.mockReturnValueOnce(new Promise((r) => (answer = r)));
    fetchMock.mockResolvedValue(new Response(null, { status: 200 }));

    const renewing = renew(CFG).catch(() => undefined);
    const out = signOut(CFG);
    const rotated = tokenBody({ suffix: "2" });
    answer(jsonResponse(200, rotated));
    await Promise.all([renewing, out]);

    expect(bodyOf(fetchMock.mock.calls[1][1]).token).toBe(
      rotated.refresh_token
    );
    expect(getTokens()).toBeNull();
  });

  it("waits at most 5 seconds for a renewal that hangs, then signs out with the held token", async () => {
    vi.useFakeTimers();
    try {
      setTokens(someTokens());
      let answer!: (r: Response) => void;
      fetchMock.mockImplementation(async (url) => {
        if (String(url).endsWith("/oauth/token"))
          return new Promise<Response>((r) => (answer = r));
        return new Response(null, { status: 200 });
      });

      const renewing = renew(CFG).catch((e: unknown) => e);
      let done = false;
      const out = signOut(CFG).then(() => (done = true));
      await vi.advanceTimersByTimeAsync(4_900);
      expect(done).toBe(false);
      expect(assign).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(200);
      await out;
      expect(getTokens()).toBeNull();
      const revoke = fetchMock.mock.calls.find(([url]) =>
        String(url).endsWith("/oauth/revoke")
      );
      expect(bodyOf(revoke?.[1]).token).toBe("rt-old");
      expect(navigatedTo().pathname).toBe("/oauth/end-session");

      // The renewal answering afterwards does not bring the session back.
      answer(jsonResponse(200, tokenBody({ suffix: "2" })));
      expect(await renewing).toBeInstanceOf(AuthError);
      expect(getTokens()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("ends the session even when signed out already", async () => {
    await signOut(CFG);
    expect(fetchMock).not.toHaveBeenCalled();
    const end = navigatedTo();
    expect(end.pathname).toBe("/oauth/end-session");
    expect(end.searchParams.has("id_token_hint")).toBe(false);
  });
});
