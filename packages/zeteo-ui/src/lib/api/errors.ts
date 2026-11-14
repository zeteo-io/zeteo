import { isAxiosError } from "axios";

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
  const res = err.response;
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
  const retry = Number(res.headers?.["retry-after"]);
  if (Number.isFinite(retry) && retry >= 0 && res.headers?.["retry-after"]) {
    out.retryAfter = retry;
  }
  return out;
};

/** The validation message zeteo gave for one field, if any. */
export const issueFor = (
  err: ApiError | null,
  path: string
): string | undefined => err?.issues?.find((i) => i.path === path)?.message;
