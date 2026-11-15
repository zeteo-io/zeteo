import axios, { type InternalAxiosRequestConfig } from "axios";
import { toApiError, type ApiError } from "./errors";
import { loadConfig } from "@/lib/config";
import {
  AuthError,
  getTokens,
  renew,
  sessionEnded,
  startLogin,
} from "@/lib/auth";

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

const renewFailed = (err: unknown): ApiError => {
  const code = err instanceof AuthError ? err.code : "renew_failed";
  return {
    status: null,
    code,
    message:
      code === "timeout"
        ? "Tereo did not answer while renewing your sign-in. Try again in a moment."
        : "Renewing your sign-in failed. Try again in a moment.",
  };
};

// The session is over (no tokens, or Tereo refused the refresh token, or kept
// refusing the access token): leave for Tereo's sign-in page, silently first
// as AuthProvider does, once. If leaving fails the next 401 may try again.
let signingIn = false;
const beginSignIn = async (): Promise<void> => {
  // AuthProvider's notice offers the sign-in, once the person is ready.
  if (signingIn || sessionEnded()) return;
  signingIn = true;
  try {
    const cfg = await loadConfig();
    const { pathname, search, hash } = window.location;
    await startLogin(cfg, {
      silent: true,
      returnTo: `${pathname}${search}${hash}`,
    });
  } catch (err) {
    signingIn = false;
    throw toApiError(err);
  }
};

const sentToken = (config: InternalAxiosRequestConfig): string | undefined => {
  const header = config.headers.get("Authorization");
  return typeof header === "string"
    ? header.replace(/^Bearer /, "")
    : undefined;
};

api.interceptors.request.use(async (config) => {
  if (!sameOrigin(config)) return config;
  if (sessionEnded()) {
    throw {
      status: null,
      code: "session_ended",
      message: "Your session ended. Sign in again to continue.",
    } satisfies ApiError;
  }
  let tokens = getTokens();
  if (tokens && tokens.expiresAt - Date.now() < RENEW_BEFORE_EXPIRY_MS) {
    try {
      tokens = await renewNow();
    } catch (err) {
      tokens = getTokens();
      // Kept but already expired: zeteo would refuse it, and the 401 path
      // would wait on Tereo again.
      if (tokens && tokens.expiresAt <= Date.now()) throw renewFailed(err);
      // Otherwise send what is held: the 401 path below decides what happens next.
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

  const held = getTokens();
  // The token just sent is still refused after a renewal, or there is none.
  if (config.zeteoRetried || !held) {
    await beginSignIn();
    throw error;
  }
  // Another request already renewed while this one was in flight.
  if (sentToken(config) !== held.accessToken) {
    return api.request({ ...config, zeteoRetried: true });
  }
  try {
    await renewNow();
  } catch (err) {
    // Tokens cleared: Tereo refused the refresh token. Tokens kept: a passing
    // failure (429, 5xx, network), which must not end the session.
    if (!getTokens()) {
      await beginSignIn();
      throw error;
    }
    throw renewFailed(err);
  }
  return api.request({ ...config, zeteoRetried: true });
});
