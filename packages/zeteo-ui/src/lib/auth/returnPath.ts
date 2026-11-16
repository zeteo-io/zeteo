// The provider sends a visitor with no session to /signed-out without saying
// where they were; this keeps it until the sign-in from /signed-out takes it.
const KEY = "zeteo-ui:return-path";

export const rememberReturnPath = (): void => {
  const { pathname, search, hash } = window.location;
  try {
    sessionStorage.setItem(KEY, `${pathname}${search}${hash}`);
  } catch {
    // Storage unavailable: sign-in lands on "/".
  }
};

/** The remembered path, removed so a later sign-in does not reuse it. */
export const takeReturnPath = (): string | undefined => {
  try {
    const path = sessionStorage.getItem(KEY) ?? undefined;
    sessionStorage.removeItem(KEY);
    return path;
  } catch {
    return undefined;
  }
};
