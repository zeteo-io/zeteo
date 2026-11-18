import type { ApiError } from "@/lib/api";
import { Alert } from "@kosmeo-ui/react";

interface ErrorNoticeProps {
  error: ApiError | null | undefined;
  /** Paths the screen shows beside their fields; other issues are listed here. */
  fieldPaths?: string[];
}

/** An API failure: its message, its issues not shown beside a field, and its findings. */
export const ErrorNotice = ({ error, fieldPaths }: ErrorNoticeProps) => {
  if (!error) return null;
  const general =
    error.issues?.filter((i) => !fieldPaths?.includes(i.path)) ?? [];
  return (
    <Alert variant="danger">
      <p>
        {error.code === "network"
          ? "zeteo could not be reached. Check your connection and try again."
          : error.message}
      </p>
      {(error.status === 429 || error.code === "file_source_busy") &&
        error.retryAfter !== undefined && (
          <p>Try again in {error.retryAfter} seconds.</p>
        )}
      {general.length > 0 && (
        <ul>
          {general.map((issue, i) => (
            <li key={i}>
              {issue.path ? `${issue.path}: ${issue.message}` : issue.message}
            </li>
          ))}
        </ul>
      )}
      {error.findings && error.findings.length > 0 && (
        <ul>
          {error.findings.map((finding, i) => (
            <li key={i}>
              <code>{finding.code}</code>: {finding.detail}
            </li>
          ))}
        </ul>
      )}
    </Alert>
  );
};
