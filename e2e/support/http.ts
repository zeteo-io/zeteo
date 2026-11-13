export interface JsonResponse {
  status: number;
  headers: Headers;
  // Each test asserts the shape it expects.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
}

/** A JSON request; `token` is sent as a bearer token. */
export const requestJson = async (
  method: string,
  url: string,
  { token, body }: { token?: string; body?: unknown } = {}
): Promise<JsonResponse> => {
  const res = await fetch(url, {
    method,
    headers: {
      Accept: "application/json",
      ...(token && { Authorization: `Bearer ${token}` }),
      ...(body !== undefined && { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    // Left as text.
  }
  return { status: res.status, headers: res.headers, body: parsed };
};

/** `requestJson`, throwing unless the status is `expected`. */
export const expectJson = async (
  expected: number,
  method: string,
  url: string,
  options: { token?: string; body?: unknown } = {}
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any> => {
  const res = await requestJson(method, url, options);
  if (res.status !== expected) {
    throw new Error(
      `${method} ${url}: expected ${expected}, got ${res.status}: ${JSON.stringify(res.body)}`
    );
  }
  return res.body;
};

export const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Calls `probe` every `intervalMs` until it returns a value other than
 * undefined, or throws once `timeoutMs` has passed. Returns the value and how
 * long it took.
 */
export const waitFor = async <T>(
  what: string,
  probe: () => Promise<T | undefined>,
  { timeoutMs, intervalMs = 1000 }: { timeoutMs: number; intervalMs?: number }
): Promise<{ value: T; elapsedMs: number }> => {
  const started = Date.now();
  for (;;) {
    const value = await probe();
    const elapsedMs = Date.now() - started;
    if (value !== undefined) return { value, elapsedMs };
    if (elapsedMs > timeoutMs) {
      throw new Error(`${what}: not within ${timeoutMs} ms`);
    }
    await sleep(intervalMs);
  }
};
