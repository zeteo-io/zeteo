// The provider sends a visitor with no session to /signed-out without saying
// where they were; this keeps it until the sign-in from /signed-out takes it.
const KEY = "zeteo-ui:return-path";

// One leading slash: "//host" and "/\host" are read by browsers as another site.
const SAME_ORIGIN_PATH = /^\/(?![/\\])/;

export const rememberReturnPath = (): void => {
  const { pathname, search, hash } = window.location;
  const path = `${pathname}${search}${hash}`;
  if (!SAME_ORIGIN_PATH.test(path)) return;
  try {
    sessionStorage.setItem(KEY, path);
  } catch {
    // Storage unavailable: sign-in lands on "/".
  }
};

/** The remembered path, removed so a later sign-in does not reuse it. */
export const takeReturnPath = (): string | undefined => {
  try {
    const path = sessionStorage.getItem(KEY) ?? undefined;
    sessionStorage.removeItem(KEY);
    return path !== undefined && SAME_ORIGIN_PATH.test(path) ? path : undefined;
  } catch {
    return undefined;
  }
};
