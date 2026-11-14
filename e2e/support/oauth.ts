import { createHash, randomBytes } from "node:crypto";
import { CLIENTS, stack, type LoginClient } from "./stack.js";

/**
 * Tereo's sign-in as a browser does it, over plain HTTP: authorize, the
 * password step the login page posts, consent when the client asks for it,
 * then the code exchange. The same exchange Tereo's own tests script.
 */

type CookieJar = Map<string, string>;

const absorbCookies = (jar: CookieJar, res: Response) => {
  for (const cookie of res.headers.getSetCookie()) {
    const [pair] = cookie.split(";");
    const eq = pair.indexOf("=");
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (!value || /expires=Thu, 01 Jan 1970/i.test(cookie)) jar.delete(name);
    else jar.set(name, value);
  }
};

const cookieHeader = (jar: CookieJar) =>
  [...jar].map(([name, value]) => `${name}=${value}`).join("; ");

const fail = async (step: string, res: Response): Promise<never> => {
  throw new Error(`${step}: ${res.status} ${await res.text()}`);
};

export interface SignInOptions {
  client: LoginClient;
  email: string;
  password?: string;
  /** Endpoints from the authorization server's metadata; Tereo's own paths by default. */
  authorizationEndpoint?: string;
  tokenEndpoint?: string;
  /** RFC 8707 resource indicator, as an MCP client sends it. */
  resource?: string;
  /** For a confidential client: sent as HTTP Basic credentials. */
  clientSecret?: string;
  scope?: string;
}

/** PKCE: a verifier and its S256 challenge. */
const pkce = () => {
  const verifier = randomBytes(32).toString("base64url");
  return {
    verifier,
    challenge: createHash("sha256").update(verifier).digest("base64url"),
  };
};

/**
 * Authorize, the password step and consent when asked: the code, its PKCE
 * verifier, and the cookies Tereo set on the way (its user session among them).
 */
const authorizeCode = async ({
  client,
  email,
  password = stack.userPassword,
  authorizationEndpoint = `${stack.tereoUrl}/oauth/authorize`,
  resource,
  scope = "openid profile email",
}: SignInOptions): Promise<{
  code: string;
  verifier: string;
  jar: CookieJar;
}> => {
  const { verifier, challenge } = pkce();
  const params: Record<string, string> = {
    response_type: "code",
    client_id: client.clientId,
    redirect_uri: client.redirectUri,
    state: randomBytes(16).toString("hex"),
    scope,
    code_challenge: challenge,
    code_challenge_method: "S256",
    ...(resource && { resource }),
  };
  const jar: CookieJar = new Map();

  const start = await fetch(
    `${authorizationEndpoint}?${new URLSearchParams(params)}`,
    { redirect: "manual" }
  );
  absorbCookies(jar, start);
  if (start.status !== 302) await fail("authorize", start);
  const loginPage = new URL(start.headers.get("location") ?? "");
  if (!loginPage.pathname.endsWith("/login")) {
    throw new Error(`authorize sent the browser to ${loginPage.href}`);
  }

  const submit = await fetch(authorizationEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookieHeader(jar) },
    body: JSON.stringify({ ...params, email, password }),
  });
  absorbCookies(jar, submit);
  if (submit.status !== 200) await fail("login", submit);
  let redirect = new URL(
    ((await submit.json()) as { redirect_url: string }).redirect_url
  );

  const session = redirect.searchParams.get("session");
  if (!redirect.searchParams.has("code") && session) {
    const consent = await fetch(`${stack.tereoUrl}/oauth/consent`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: cookieHeader(jar),
      },
      body: JSON.stringify({ session_token: session, approved: true }),
    });
    absorbCookies(jar, consent);
    if (consent.status !== 200) await fail("consent", consent);
    redirect = new URL(
      ((await consent.json()) as { redirect_url: string }).redirect_url
    );
  }
  const code = redirect.searchParams.get("code");
  if (!code) throw new Error(`no code in ${redirect.href}`);
  if (redirect.searchParams.get("state") !== params.state) {
    throw new Error("the state came back changed");
  }
  return { code, verifier, jar };
};

/** Signs `email` in through `client` and returns the access token. */
export const signIn = async (options: SignInOptions): Promise<string> => {
  const {
    client,
    tokenEndpoint = `${stack.tereoUrl}/oauth/token`,
    resource,
    clientSecret,
  } = options;
  const { code, verifier } = await authorizeCode(options);

  const form = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: client.redirectUri,
    code_verifier: verifier,
    ...(clientSecret === undefined && { client_id: client.clientId }),
    ...(resource && { resource }),
  });
  const token = await fetch(tokenEndpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      ...(clientSecret !== undefined && {
        Authorization: `Basic ${Buffer.from(`${client.clientId}:${clientSecret}`).toString("base64")}`,
      }),
    },
    body: form,
  });
  if (token.status !== 200) await fail("token", token);
  return ((await token.json()) as { access_token: string }).access_token;
};

/** A client-credentials token for a confidential client, as a service gets its own. */
export const serviceToken = async (
  clientId: string,
  clientSecret: string
): Promise<string> => {
  const res = await fetch(`${stack.tereoUrl}/oauth/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
    },
    body: new URLSearchParams({ grant_type: "client_credentials" }),
  });
  if (res.status !== 200) await fail("client credentials", res);
  return ((await res.json()) as { access_token: string }).access_token;
};

/**
 * A public client's sign-in as a page on another origin runs it: the browser
 * goes through Tereo's login, then the page exchanges the code itself, so the
 * token request carries the page's `Origin`. The refresh token is asked for
 * in the body (no `refresh_token_response_mode`), for the page to hold in
 * memory.
 */

const loginClient = (clientId: string): LoginClient => {
  const client = Object.values(CLIENTS).find((c) => c.clientId === clientId);
  if (!client) throw new Error(`no login client ${clientId} in CLIENTS`);
  return client;
};

export interface TokenResponse {
  status: number;
  headers: Headers;
  // Each test asserts the shape it expects.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
}

const postForm = async (
  path: string,
  form: Record<string, string>,
  origin: string
): Promise<TokenResponse> => {
  const res = await fetch(`${stack.tereoUrl}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Origin: origin,
    },
    body: new URLSearchParams(form),
  });
  const text = await res.text();
  return {
    status: res.status,
    headers: res.headers,
    body: text ? JSON.parse(text) : null,
  };
};

export interface PublicSignIn {
  accessToken: string;
  refreshToken: string;
  idToken: string;
  /** Tereo's cookies from the login, as a `Cookie` header: its user session among them. */
  cookies: string;
  /** The token response's headers, for its CORS answer. */
  headers: Headers;
}

export const signInPublic = async (
  clientId: string,
  user: { email: string },
  { origin }: { origin: string }
): Promise<PublicSignIn> => {
  const client = loginClient(clientId);
  const { code, verifier, jar } = await authorizeCode({
    client,
    email: user.email,
    scope: "openid profile email offline_access",
  });
  const token = await postForm(
    "/oauth/token",
    {
      grant_type: "authorization_code",
      code,
      redirect_uri: client.redirectUri,
      code_verifier: verifier,
      client_id: clientId,
    },
    origin
  );
  if (token.status !== 200) {
    throw new Error(`token: ${token.status} ${JSON.stringify(token.body)}`);
  }
  return {
    accessToken: token.body.access_token,
    refreshToken: token.body.refresh_token,
    idToken: token.body.id_token,
    cookies: cookieHeader(jar),
    headers: token.headers,
  };
};

/** A refresh with the token in the body, sent from `origin`. */
export const refreshPublic = (
  clientId: string,
  refreshToken: string,
  { origin }: { origin: string }
): Promise<TokenResponse> =>
  postForm(
    "/oauth/token",
    {
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId,
    },
    origin
  );

/** RFC 7009 revocation of `token` by a public client, sent from `origin`. */
export const revokePublic = (
  clientId: string,
  token: string,
  { origin }: { origin: string }
): Promise<TokenResponse> =>
  postForm(
    "/oauth/revoke",
    { token, token_type_hint: "refresh_token", client_id: clientId },
    origin
  );

/**
 * `prompt=none`, as a page renews its sign-in in a top-level redirect: with
 * Tereo's cookies `cookies` (a `Cookie` header), or none. Returns what the
 * redirect back to the client carries.
 */
export const authorizeSilently = async (
  clientId: string,
  cookies?: string
): Promise<{ code?: string; error?: string }> => {
  const client = loginClient(clientId);
  const { challenge } = pkce();
  const state = randomBytes(16).toString("hex");
  const res = await fetch(
    `${stack.tereoUrl}/oauth/authorize?${new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: client.redirectUri,
      state,
      scope: "openid profile email offline_access",
      code_challenge: challenge,
      code_challenge_method: "S256",
      prompt: "none",
    })}`,
    { redirect: "manual", headers: cookies ? { Cookie: cookies } : {} }
  );
  if (res.status !== 302) await fail("authorize prompt=none", res);
  const redirect = new URL(res.headers.get("location") ?? "");
  if (`${redirect.origin}${redirect.pathname}` !== client.redirectUri) {
    throw new Error(`prompt=none sent the browser to ${redirect.href}`);
  }
  if (redirect.searchParams.get("state") !== state) {
    throw new Error("the state came back changed");
  }
  return {
    code: redirect.searchParams.get("code") ?? undefined,
    error: redirect.searchParams.get("error") ?? undefined,
  };
};
