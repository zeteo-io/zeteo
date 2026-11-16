import { activeConfig } from "@tereo-io/react";

// The provider sends a visitor with no session to /signed-out without saying
// where they were; this keeps it, in the key `signIn({ returnTo })` uses for
// the same purpose, so the sign-in from /signed-out lands back there.
const key = () => activeConfig().keys.postLoginPath;

export const rememberReturnPath = (): void => {
  const { pathname, search, hash } = window.location;
  try {
    sessionStorage.setItem(key(), `${pathname}${search}${hash}`);
  } catch {
    // Storage unavailable: sign-in lands on "/".
  }
};

export const takeReturnPath = (): string | undefined => {
  try {
    return sessionStorage.getItem(key()) ?? undefined;
  } catch {
    return undefined;
  }
};
