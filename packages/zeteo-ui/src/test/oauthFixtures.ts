import type { UiConfig } from "@/lib/config";

export const CFG: UiConfig = {
  tereoUrl: "https://tereo.test",
  clientId: "zeteo-ui",
};

export const LOGIN_KEY = "zeteo-ui:login";

const base64url = (text: string) =>
  btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** An unsigned JWT-shaped string; the UI only reads its claims. */
export const makeJwt = (payload: Record<string, unknown>) =>
  `${base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${base64url(
    JSON.stringify(payload)
  )}.c2lnbmF0dXJlLW5vdC1jaGVja2Vk`;

export const jsonResponse = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

export interface StoredLogin {
  verifier: string;
  state: string;
  nonce: string;
  returnTo: string;
}

export const storeLogin = (over: Partial<StoredLogin> = {}): StoredLogin => {
  const login: StoredLogin = {
    verifier: "v".repeat(43),
    state: "state-1",
    nonce: "nonce-1",
    returnTo: "/",
    ...over,
  };
  sessionStorage.setItem(LOGIN_KEY, JSON.stringify(login));
  return login;
};

export const tokenBody = ({
  nonce = "nonce-1",
  aud = CFG.clientId as string | string[],
  suffix = "1",
  expiresIn = 900,
  idToken = true,
}: {
  nonce?: string;
  aud?: string | string[];
  suffix?: string;
  expiresIn?: number;
  idToken?: boolean;
} = {}) => ({
  access_token: makeJwt({ sub: "user-1", aud: ["zeteo"], jti: `at-${suffix}` }),
  refresh_token: `rt-${suffix}-Qm9vbXNoYWthbGFrYWJvb20tcmVmcmVzaA`,
  ...(idToken && {
    id_token: makeJwt({ sub: "user-1", aud, nonce, jti: `id-${suffix}` }),
  }),
  expires_in: expiresIn,
  token_type: "Bearer",
});

export const callbackUrl = (params: Record<string, string>) =>
  new URL(`${window.location.origin}/callback?${new URLSearchParams(params)}`);

export const bodyOf = (init: RequestInit | undefined) =>
  Object.fromEntries(new URLSearchParams(String(init?.body ?? "")));

/** Each token, and each long JWT segment on its own in case one is stored split. */
export const secretsOf = (issued: ReturnType<typeof tokenBody>[]) =>
  issued.flatMap((t) =>
    [t.access_token, t.refresh_token, t.id_token]
      .filter((s): s is string => typeof s === "string")
      .flatMap((s) => [s, ...s.split(".").filter((part) => part.length > 20)])
  );

/** Every place outside memory a token could end up in this page. */
export const exposedSurface = () =>
  [
    JSON.stringify({ ...localStorage }),
    JSON.stringify({ ...sessionStorage }),
    document.cookie,
    window.location.href,
  ].join("\n");
