import { challengeFor, createVerifier, randomToken } from "./pkce";
import { getTokens, setTokens, type Tokens } from "./tokens";
import type { UiConfig } from "@/lib/config";

export const CALLBACK_PATH = "/callback";
const LOGIN_KEY = "zeteo-ui:login";
const SCOPES = "openid profile email offline_access";

/** A failed sign-in step. `code` is an OAuth error code or one of this module's own. */
export class AuthError extends Error {
  readonly code: string;
  /** Set on an authorization error that came back for the login started here. */
  readonly returnTo?: string;

  constructor(code: string, returnTo?: string) {
    super(code);
    this.name = "AuthError";
    this.code = code;
    this.returnTo = returnTo;
  }
}

/** Every navigation away from the page goes through here, so tests can watch it. */
export const navigation = {
  assign(url: string): void {
    window.location.assign(url);
  },
};

interface LoginState {
  verifier: string;
  state: string;
  nonce: string;
  returnTo: string;
}

const redirectUri = () => `${window.location.origin}${CALLBACK_PATH}`;

/** A path on this origin to land on after sign-in; anything else becomes `/`. */
export const safeReturnTo = (value: unknown): string => {
  if (
    typeof value !== "string" ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    value.includes("\\")
  ) {
    return "/";
  }
  try {
    // The URL parser drops tabs and newlines, so "/\t/host" would become "//host".
    const url = new URL(value, window.location.origin);
    if (url.origin !== window.location.origin) return "/";
    if (url.pathname === CALLBACK_PATH) return "/";
  } catch {
    return "/";
  }
  return value;
};

const takeLoginState = (): LoginState | null => {
  let raw: string | null;
  try {
    raw = sessionStorage.getItem(LOGIN_KEY);
    sessionStorage.removeItem(LOGIN_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const { verifier, state, nonce, returnTo } = parsed;
    if (
      typeof verifier !== "string" ||
      typeof state !== "string" ||
      typeof nonce !== "string" ||
      !verifier ||
      !state ||
      !nonce
    ) {
      return null;
    }
    return { verifier, state, nonce, returnTo: safeReturnTo(returnTo) };
  } catch {
    return null;
  }
};

export const startLogin = async (
  cfg: UiConfig,
  {
    silent = false,
    returnTo = "/",
  }: { silent?: boolean; returnTo?: string } = {}
): Promise<void> => {
  // crypto.subtle exists only in a secure context (https or localhost).
  if (window.isSecureContext === false || !globalThis.crypto?.subtle) {
    throw new AuthError("insecure_context");
  }
  const login: LoginState = {
    verifier: createVerifier(),
    state: randomToken(),
    nonce: randomToken(),
    returnTo: safeReturnTo(returnTo),
  };
  const challenge = await challengeFor(login.verifier);
  sessionStorage.setItem(LOGIN_KEY, JSON.stringify(login));

  const params = new URLSearchParams({
    response_type: "code",
    client_id: cfg.clientId,
    redirect_uri: redirectUri(),
    scope: SCOPES,
    state: login.state,
    nonce: login.nonce,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  if (silent) params.set("prompt", "none");
  navigation.assign(`${cfg.tereoUrl}/oauth/authorize?${params}`);
};

// Only codes of this shape are kept: they end up on screen.
const cleanCode = (value: unknown, fallback: string): string =>
  typeof value === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(value)
    ? value
    : fallback;

// Never with cookies: the tokens travel in the body, and Tereo's session
// cookie is for its own pages only.
const postForm = async (
  cfg: UiConfig,
  path: string,
  form: Record<string, string>,
  signal?: AbortSignal
): Promise<Response> => {
  try {
    return await fetch(`${cfg.tereoUrl}${path}`, {
      signal,
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: new URLSearchParams(form),
      credentials: "omit",
    });
  } catch {
    throw new AuthError("tereo_unreachable");
  }
};

const errorCodeOf = async (res: Response): Promise<string> => {
  try {
    const body = (await res.json()) as { error?: unknown };
    return cleanCode(body?.error, `http_${res.status}`);
  } catch {
    return `http_${res.status}`;
  }
};

const nonEmpty = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

const readTokens = async (res: Response, held?: Tokens): Promise<Tokens> => {
  let body: Record<string, unknown>;
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    throw new AuthError("invalid_token_response");
  }
  const { access_token, refresh_token, id_token, expires_in } = body ?? {};
  const refreshToken = nonEmpty(refresh_token)
    ? refresh_token
    : held?.refreshToken;
  const idToken = nonEmpty(id_token) ? id_token : held?.idToken;
  if (
    !nonEmpty(access_token) ||
    !refreshToken ||
    !idToken ||
    typeof expires_in !== "number" ||
    !(expires_in > 0)
  ) {
    throw new AuthError("invalid_token_response");
  }
  return {
    accessToken: access_token,
    refreshToken,
    idToken,
    expiresAt: Date.now() + expires_in * 1000,
  };
};

interface IdClaims {
  aud?: unknown;
  nonce?: unknown;
  exp?: unknown;
}

// No signature check: the token came straight from Tereo's token endpoint,
// over the connection this page opened.
const decodeClaims = (jwt: string): IdClaims | null => {
  const parts = jwt.split(".");
  if (parts.length !== 3) return null;
  try {
    const binary = atob(parts[1].replace(/-/g, "+").replace(/_/g, "/"));
    const json = new TextDecoder().decode(
      Uint8Array.from(binary, (c) => c.charCodeAt(0))
    );
    const claims = JSON.parse(json) as unknown;
    return typeof claims === "object" &&
      claims !== null &&
      !Array.isArray(claims)
      ? (claims as IdClaims)
      : null;
  } catch {
    return null;
  }
};

const audienceIncludes = (aud: unknown, clientId: string): boolean =>
  aud === clientId || (Array.isArray(aud) && aud.includes(clientId));

const exchange = async (
  cfg: UiConfig,
  callbackUrl: URL
): Promise<{ returnTo: string }> => {
  const login = takeLoginState();
  if (!login) throw new AuthError("no_login_state");
  const params = callbackUrl.searchParams;
  if (params.get("state") !== login.state) {
    throw new AuthError("state_mismatch");
  }
  const error = params.get("error");
  if (error !== null) {
    throw new AuthError(
      cleanCode(error, "authorization_error"),
      login.returnTo
    );
  }
  const code = params.get("code");
  if (!code) throw new AuthError("missing_code");

  const res = await postForm(cfg, "/oauth/token", {
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri(),
    client_id: cfg.clientId,
    code_verifier: login.verifier,
  });
  if (!res.ok) throw new AuthError(await errorCodeOf(res));
  const tokens = await readTokens(res);

  const claims = decodeClaims(tokens.idToken);
  if (!claims) throw new AuthError("invalid_id_token");
  if (claims.nonce !== login.nonce) throw new AuthError("nonce_mismatch");
  if (!audienceIncludes(claims.aud, cfg.clientId)) {
    throw new AuthError("audience_mismatch");
  }

  setTokens(tokens);
  return { returnTo: login.returnTo };
};

// A code can be exchanged only once; a second call for the same callback
// (React StrictMode runs effects twice) gets the first call's result.
let completing: { href: string; result: Promise<{ returnTo: string }> } | null =
  null;

export const completeLogin = (
  cfg: UiConfig,
  callbackUrl: URL
): Promise<{ returnTo: string }> => {
  if (completing?.href !== callbackUrl.href) {
    completing = { href: callbackUrl.href, result: exchange(cfg, callbackUrl) };
  }
  return completing.result;
};

const refresh = async (cfg: UiConfig): Promise<Tokens> => {
  const held = getTokens();
  if (!held) throw new AuthError("signed_out");

  const res = await postForm(cfg, "/oauth/token", {
    grant_type: "refresh_token",
    refresh_token: held.refreshToken,
    client_id: cfg.clientId,
  });
  if (!res.ok) {
    const code = await errorCodeOf(res);
    // 400 invalid_grant (revoked, expired, or its family ended) or 401: the
    // refresh token is dead. A 429, a 5xx and the like leave it for another try.
    if ((res.status === 400 || res.status === 401) && getTokens() === held) {
      setTokens(null);
    }
    throw new AuthError(code);
  }
  const tokens = await readTokens(res, held);
  // Signed out (or signed in afresh) while this was in flight.
  if (getTokens() !== held) throw new AuthError("signed_out");
  setTokens(tokens);
  return tokens;
};

// Tereo rotates the refresh token on every use and ends the whole family
// when a used one is replayed, so two refreshes must never overlap.
let renewing: Promise<Tokens> | null = null;

export const renew = (cfg: UiConfig): Promise<Tokens> => {
  renewing ??= refresh(cfg).finally(() => {
    renewing = null;
  });
  return renewing;
};

// Tereo refuses an id_token_hint that expired more than an hour ago
// (ID_TOKEN_HINT_GRACE_SECONDS); without one it asks the person to confirm.
const HINT_GRACE_MS = 60 * 60 * 1000;
const REVOKE_TIMEOUT_MS = 5_000;

const usableHint = (idToken: string): string | null => {
  const exp = decodeClaims(idToken)?.exp;
  if (typeof exp !== "number") return idToken;
  return Date.now() - exp * 1000 > HINT_GRACE_MS ? null : idToken;
};

export const signOut = async (cfg: UiConfig): Promise<void> => {
  // Revoke the refresh token a renewal in flight is about to hand back.
  if (renewing) await renewing.catch(() => undefined);
  const held = getTokens();
  setTokens(null);
  try {
    sessionStorage.removeItem(LOGIN_KEY);
  } catch {
    // Nothing stored.
  }

  if (held) {
    // Best effort, and bounded: end-session below still ends Tereo's session.
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        abort.abort();
        resolve();
      }, REVOKE_TIMEOUT_MS);
    });
    const revoked = postForm(
      cfg,
      "/oauth/revoke",
      {
        token: held.refreshToken,
        token_type_hint: "refresh_token",
        client_id: cfg.clientId,
      },
      abort.signal
    ).then(
      () => undefined,
      () => undefined
    );
    await Promise.race([revoked, timedOut]);
    clearTimeout(timer);
  }

  const params = new URLSearchParams({
    client_id: cfg.clientId,
    post_logout_redirect_uri: `${window.location.origin}/`,
  });
  const hint = held && usableHint(held.idToken);
  if (hint) params.set("id_token_hint", hint);
  navigation.assign(`${cfg.tereoUrl}/oauth/end-session?${params}`);
};
