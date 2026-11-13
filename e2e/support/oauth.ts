import { createHash, randomBytes } from "node:crypto";
import { stack, type LoginClient } from "./stack.js";

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

/** Signs `email` in through `client` and returns the access token. */
export const signIn = async ({
  client,
  email,
  password = stack.userPassword,
  authorizationEndpoint = `${stack.tereoUrl}/oauth/authorize`,
  tokenEndpoint = `${stack.tereoUrl}/oauth/token`,
  resource,
  clientSecret,
  scope = "openid profile email",
}: SignInOptions): Promise<string> => {
  const verifier = randomBytes(32).toString("base64url");
  const params: Record<string, string> = {
    response_type: "code",
    client_id: client.clientId,
    redirect_uri: client.redirectUri,
    state: randomBytes(16).toString("hex"),
    scope,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
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
