import axios, { isAxiosError } from "axios";

export interface ApiError {
  /** Null when no response came back at all. */
  status: number | null;
  code: string;
  message: string;
  issues?: { path: string; message: string }[];
  findings?: { code: string; detail: string }[];
  /** Seconds, from `Retry-After`. */
  retryAfter?: number;
}

const isApiError = (err: unknown): err is ApiError =>
  typeof err === "object" &&
  err !== null &&
  !(err instanceof Error) &&
  "code" in err &&
  "message" in err &&
  "status" in err;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const issuesOf = (v: unknown): ApiError["issues"] =>
  Array.isArray(v)
    ? v.filter(isRecord).map((i) => ({
        path: String(i.path ?? ""),
        message: String(i.message ?? ""),
      }))
    : undefined;

const findingsOf = (v: unknown): ApiError["findings"] =>
  Array.isArray(v)
    ? v.filter(isRecord).map((f) => ({
        code: String(f.code ?? ""),
        detail: String(f.detail ?? ""),
      }))
    : undefined;

// Retry-After is seconds or an HTTP date.
const retryAfterSeconds = (value: unknown): number | undefined => {
  if (typeof value !== "string" || value.trim() === "") return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds);
  const date = Date.parse(value);
  return Number.isNaN(date)
    ? undefined
    : Math.max(0, Math.ceil((date - Date.now()) / 1000));
};

/** Maps what a failed request threw to the one shape the screens handle. */
export const toApiError = (err: unknown): ApiError => {
  if (isApiError(err)) return err;
  if (!isAxiosError(err)) {
    return {
      status: null,
      code: "unknown",
      message: err instanceof Error ? err.message : String(err),
    };
  }
  if (axios.isCancel(err)) {
    return {
      status: null,
      code: "cancelled",
      message: "The request was cancelled",
    };
  }
  const res = err.response;
  if (!res && (err.code === "ECONNABORTED" || err.code === "ETIMEDOUT")) {
    return {
      status: null,
      code: "timeout",
      message: "zeteo took too long to answer. Try again.",
    };
  }
  if (!res) {
    return {
      status: null,
      code: "network",
      message: "zeteo could not be reached",
    };
  }
  const body = isRecord(res.data) ? res.data : {};
  const out: ApiError = {
    status: res.status,
    code: typeof body.error === "string" ? body.error : `http_${res.status}`,
    message:
      typeof body.error_description === "string"
        ? body.error_description
        : `The request failed (${res.status})`,
  };
  const issues = issuesOf(body.issues);
  if (issues) out.issues = issues;
  const findings = findingsOf(body.findings);
  if (findings) out.findings = findings;
  const retry = retryAfterSeconds(res.headers?.["retry-after"]);
  if (retry !== undefined) out.retryAfter = retry;
  return out;
};

/** The validation message zeteo gave for one field, if any. */
export const issueFor = (
  err: ApiError | null,
  path: string
): string | undefined => err?.issues?.find((i) => i.path === path)?.message;
