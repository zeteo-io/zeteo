import type { DianemoResponse, RequestConfig } from "@dianemo/core";
import { OPERATIONS, type OperationId } from "./operations.js";
import { QueryRefusedError, ZeteoError } from "./errors.js";
import type { ClientNames } from "./template.js";
import type RequestHandler from "@dianemo/core";
import { buildPath } from "./paths.js";

export interface Transport {
  handler: RequestHandler;
  names: ClientNames;
  purgeServiceToken(): Promise<void>;
  getRequestId?: () => string | undefined;
}

export interface CallContext {
  transport: Transport;
  /** A person's bearer token; absent means the service's own credentials. */
  token?: string;
}

export interface SendOptions {
  op: OperationId;
  params?: Record<string, string>;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  /** Use the client that never retries after a 5xx or a dropped connection. */
  once?: boolean;
  nullOn404?: boolean;
  signal?: AbortSignal;
  stream?: boolean;
  headers?: Record<string, string>;
}

type Body = Record<string, unknown>;

const isObject = (value: unknown): value is Body =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  typeof (value as { pipe?: unknown }).pipe !== "function";

// Axios headers are an AxiosHeaders instance or a plain object, by version.
function header(headers: unknown, name: string): string | undefined {
  if (!headers || typeof headers !== "object") return undefined;
  const h = headers as { get?: (n: string) => unknown } & Record<
    string,
    unknown
  >;
  const value = typeof h.get === "function" ? h.get(name) : h[name];
  return typeof value === "string" ? value : undefined;
}

const str = (value: unknown): string | undefined =>
  typeof value === "string" && value !== "" ? value : undefined;

// Everything thrown is built from these fields only: an axios error carries
// the request's Authorization header and the client's oauth config.
function fromResponse(response: {
  status: number;
  statusText?: string;
  data?: unknown;
  headers?: unknown;
}): ZeteoError {
  const { status } = response;
  const body: Body = isObject(response.data) ? response.data : {};
  const retryHeader = Number.parseInt(
    header(response.headers, "retry-after") ?? "",
    10
  );
  const init = {
    status,
    code: str(body.error) ?? `http_${status}`,
    requestId: str(body.request_id) ?? header(response.headers, "x-request-id"),
    retryAfter:
      typeof body.retry_after === "number"
        ? body.retry_after
        : Number.isNaN(retryHeader)
          ? undefined
          : retryHeader,
    issues: Array.isArray(body.issues)
      ? (body.issues as { path: string; message: string }[])
      : undefined,
    findings: Array.isArray(body.findings) ? body.findings : undefined,
  };
  const message =
    str(body.error_description) ?? str(response.statusText) ?? `HTTP ${status}`;
  if (status === 422 && Array.isArray(body.path)) {
    return new QueryRefusedError(message, {
      ...init,
      path: body.path as (string | number)[],
      suggestions: Array.isArray(body.suggestions)
        ? (body.suggestions as string[])
        : [],
    });
  }
  return new ZeteoError(message, init);
}

function mapError(error: unknown, signal?: AbortSignal): ZeteoError {
  if (error instanceof ZeteoError) return error;
  const response = (error as { response?: Parameters<typeof fromResponse>[0] })
    ?.response;
  if (response && typeof response.status === "number") {
    return fromResponse(response);
  }
  const message = error instanceof Error ? error.message : String(error);
  return new ZeteoError(message, {
    status: null,
    code: signal?.aborted ? "aborted" : "unreachable",
    cause: new Error(message),
  });
}

async function execute(
  ctx: CallContext,
  options: SendOptions
): Promise<DianemoResponse> {
  const { transport, token } = ctx;
  const { names } = transport;
  const op = OPERATIONS[options.op];
  const path = buildPath(op.path, options.params ?? {});
  const clientName = token
    ? options.once
      ? names.personOnce
      : names.person
    : options.once
      ? names.serviceOnce
      : names.service;

  const headers: Record<string, string> = { ...options.headers };
  if (token) headers.Authorization = `Bearer ${token}`;
  const requestId = transport.getRequestId?.();
  if (requestId) headers["X-Request-ID"] = requestId;

  const params = Object.fromEntries(
    Object.entries(options.query ?? {}).filter(([, v]) => v !== undefined)
  );

  const config: RequestConfig = {
    clientName,
    requestName: `zeteo.${options.op}`,
    method: op.method,
    url: path,
    headers,
    ...(Object.keys(params).length > 0 ? { params } : {}),
    ...(options.body !== undefined ? { data: options.body } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.stream ? { responseType: "stream" as const } : {}),
  };

  const attempt = async (): Promise<DianemoResponse> => {
    try {
      return await transport.handler.handleRequest(config);
    } catch (error) {
      throw mapError(error, options.signal);
    }
  };

  try {
    return await attempt();
  } catch (error) {
    if (!(error instanceof ZeteoError) || error.status !== 401 || token) {
      throw error;
    }
  }
  // The service token may have been revoked or rotated; fetch a new one, once.
  await transport.purgeServiceToken();
  return attempt();
}

export async function sendRaw(
  ctx: CallContext,
  options: SendOptions
): Promise<DianemoResponse> {
  return execute(ctx, options);
}

export async function send<T>(
  ctx: CallContext,
  options: SendOptions
): Promise<T> {
  try {
    return (await execute(ctx, options)).data as T;
  } catch (error) {
    if (
      options.nullOn404 &&
      error instanceof ZeteoError &&
      error.status === 404
    ) {
      return null as T;
    }
    throw error;
  }
}
