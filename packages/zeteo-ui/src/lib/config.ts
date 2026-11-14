export interface UiConfig {
  tereoUrl: string;
  clientId: string;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

const CONFIG_PATH = "/ui-config.json";

const parseConfig = (body: unknown): UiConfig => {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new ConfigError(`${CONFIG_PATH} is not a JSON object`);
  }
  const { tereo_url, client_id } = body as Record<string, unknown>;
  if (typeof client_id !== "string" || client_id === "") {
    throw new ConfigError(`${CONFIG_PATH} has no client_id`);
  }
  if (typeof tereo_url !== "string") {
    throw new ConfigError(`${CONFIG_PATH} has no tereo_url`);
  }
  let url: URL;
  try {
    url = new URL(tereo_url);
  } catch {
    throw new ConfigError(`${CONFIG_PATH}'s tereo_url is not a URL`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new ConfigError(`${CONFIG_PATH}'s tereo_url is not an http(s) URL`);
  }
  return { tereoUrl: tereo_url.replace(/\/+$/, ""), clientId: client_id };
};

const fetchConfig = async (): Promise<UiConfig> => {
  let res: Response;
  try {
    res = await fetch(CONFIG_PATH, {
      credentials: "same-origin",
      headers: { Accept: "application/json" },
    });
  } catch {
    throw new ConfigError(`${CONFIG_PATH} could not be fetched`);
  }
  if (res.status !== 200) {
    throw new ConfigError(
      res.status === 404
        ? `${CONFIG_PATH} answered 404: the admin UI is not configured on this zeteo (UI_CLIENT_ID is unset)`
        : `${CONFIG_PATH} answered ${res.status}`
    );
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new ConfigError(`${CONFIG_PATH} is not JSON`);
  }
  return parseConfig(body);
};

let pending: Promise<UiConfig> | null = null;

export const loadConfig = (): Promise<UiConfig> => {
  pending ??= fetchConfig().catch((err: unknown) => {
    pending = null;
    throw err;
  });
  return pending;
};
