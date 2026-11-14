// Tokens live in this module's memory only, never in web storage, a cookie
// or the URL: a reload signs in again (silently, while Tereo's session lasts).

export interface Tokens {
  accessToken: string;
  refreshToken: string;
  idToken: string;
  /** Epoch milliseconds. */
  expiresAt: number;
}

type Listener = (tokens: Tokens | null) => void;

let current: Tokens | null = null;
const listeners = new Set<Listener>();

export const getTokens = (): Tokens | null => current;

export const setTokens = (tokens: Tokens | null): void => {
  current = tokens;
  for (const listener of listeners) listener(tokens);
};

export const subscribeTokens = (listener: Listener): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
