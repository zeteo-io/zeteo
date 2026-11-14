import axios, { type InternalAxiosRequestConfig } from "axios";
import { getTokens, renew, startLogin } from "@/lib/auth";
import { loadConfig } from "@/lib/config";

const RENEW_BEFORE_EXPIRY_MS = 60_000;

declare module "axios" {
  interface AxiosRequestConfig {
    /** Set on the one repeat of a request that was answered 401. */
    zeteoRetried?: boolean;
  }
}

export const api = axios.create({ baseURL: "" });

const sameOrigin = (config: InternalAxiosRequestConfig): boolean => {
  try {
    const url = new URL(axios.getUri(config) || "/", window.location.origin);
    return url.origin === window.location.origin;
  } catch {
    return false;
  }
};

const renewNow = async () => renew(await loadConfig());

// A renewal that cannot succeed (or a token Tereo keeps refusing) means the
// session is over: leave for Tereo's sign-in page, once.
let signingIn = false;
const beginSignIn = async (): Promise<void> => {
  if (signingIn) return;
  signingIn = true;
  try {
    const cfg = await loadConfig();
    const { pathname, search, hash } = window.location;
    await startLogin(cfg, { returnTo: `${pathname}${search}${hash}` });
  } catch {
    // The auth module shows its own error; the request still rejects.
  }
};

api.interceptors.request.use(async (config) => {
  if (!sameOrigin(config)) return config;
  let tokens = getTokens();
  if (tokens && tokens.expiresAt - Date.now() < RENEW_BEFORE_EXPIRY_MS) {
    try {
      tokens = await renewNow();
    } catch {
      // Send what is held: the 401 path below decides what happens next.
      tokens = getTokens();
    }
  }
  if (tokens)
    config.headers.set("Authorization", `Bearer ${tokens.accessToken}`);
  return config;
});

api.interceptors.response.use(undefined, async (error: unknown) => {
  if (!axios.isAxiosError(error) || error.response?.status !== 401) {
    throw error;
  }
  const config = error.config;
  if (!config || !sameOrigin(config)) throw error;
  if (config.zeteoRetried) {
    await beginSignIn();
    throw error;
  }
  try {
    await renewNow();
  } catch {
    await beginSignIn();
    throw error;
  }
  return api.request({ ...config, zeteoRetried: true });
});
