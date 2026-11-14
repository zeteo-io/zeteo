import type { RefreshSummary, TestResult } from "../api/types";
import { ConfirmButton } from "@/components/ConfirmButton";
import { useArchiveSource } from "../api/useArchiveSource";
import { useRefreshSource } from "../api/useRefreshSource";
import { ErrorNotice } from "@/components/ErrorNotice";
import { useTestSource } from "../api/useTestSource";
import { sourceStatusLabel } from "./SourceStatus";
import { useSourceContext } from "./SourceLayout";
import { Alert, Button } from "@kosmeo-ui/react";
import { formatDate } from "@/utils/formatDate";
import { useNavigate } from "react-router-dom";
import type { ApiError } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useState } from "react";
import "./styles.css";

const Counts = ({ label, counts }: { label: string; counts: object }) => (
  <li>
    {label}:{" "}
    {Object.entries(counts)
      .map(([name, n]) => `${n} ${name}`)
      .join(", ")}
  </li>
);

export const SourceDetailPage = () => {
  const { source } = useSourceContext();
  const { can } = useAuth();
  const navigate = useNavigate();
  const test = useTestSource(source.id);
  const refresh = useRefreshSource(source.id);
  const archive = useArchiveSource(source.id);
  const [testResult, setTestResult] = useState<TestResult | null>(null);
  const [summary, setSummary] = useState<RefreshSummary | null>(null);
  const [error, setError] = useState<ApiError | null>(null);

  const canWrite = can("zeteo.sources.write") && !source.archived_at;
  const busy = test.isPending || refresh.isPending;

  const runTest = () => {
    if (busy) return;
    setError(null);
    setTestResult(null);
    test.mutate(undefined, {
      onSuccess: setTestResult,
      onError: setError,
    });
  };
  const runRefresh = () => {
    if (busy) return;
    setError(null);
    setSummary(null);
    refresh.mutate(undefined, {
      onSuccess: setSummary,
      onError: setError,
    });
  };

  const facts: [string, string][] = [
    ["Slug", source.slug],
    ["Type", source.type],
    ["Status", sourceStatusLabel(source)],
    ["Schemas", source.schemas.join(", ")],
    ["Timeout (ms)", String(source.timeout_ms)],
    ["Row cap", String(source.row_cap)],
    ["Export enabled", source.export_enabled ? "Yes" : "No"],
    ["Export row cap", String(source.export_row_cap)],
    ["Query concurrency", String(source.query_concurrency)],
    ["Export concurrency", String(source.export_concurrency)],
    ["Writable login allowed", source.writable_login_allowed ? "Yes" : "No"],
    ["Last refreshed", formatDate(source.last_refreshed_at)],
    ["Created", formatDate(source.created_at)],
    ...(source.archived_at
      ? [["Archived", formatDate(source.archived_at)] as [string, string]]
      : []),
  ];

  return (
    <>
      {canWrite && (
        <div className="z-source-actions">
          <Button
            fullWidth={false}
            onClick={() => navigate(`/sources/${source.id}/edit`)}
          >
            Edit
          </Button>
          <Button
            variant="secondary"
            fullWidth={false}
            isLoading={test.isPending}
            disabled={busy}
            onClick={runTest}
          >
            Test
          </Button>
          <Button
            variant="secondary"
            fullWidth={false}
            isLoading={refresh.isPending}
            disabled={busy}
            onClick={runRefresh}
          >
            Refresh
          </Button>
          <ConfirmButton
            danger
            label="Archive"
            confirmTitle="Archive this source?"
            confirmText="Archiving closes the source's connections and stops all further changes to it. It cannot be undone."
            confirmLabel="Archive source"
            onConfirm={() => archive.mutateAsync()}
          />
        </div>
      )}
      <ErrorNotice error={error} />
      {testResult && (
        <div className="z-source-result">
          <Alert variant={testResult.findings.length ? "warning" : "success"}>
            {testResult.findings.length === 0 ? (
              "No findings"
            ) : (
              <>
                This login holds rights a read-only login would not:
                <ul>
                  {testResult.findings.map((f, i) => (
                    <li key={i}>
                      <code>{f.code}</code>: {f.detail}
                    </li>
                  ))}
                </ul>
                {testResult.truncated && <p>More findings were left out.</p>}
              </>
            )}
          </Alert>
        </div>
      )}
      {summary && (
        <div className="z-source-result">
          <Alert variant="success">
            Catalogue refreshed
            <ul>
              <Counts label="Tables" counts={summary.tables} />
              <Counts label="Columns" counts={summary.columns} />
              <Counts label="Relations" counts={summary.relations} />
            </ul>
          </Alert>
        </div>
      )}
      <section className="z-source-section">
        <h2>Details</h2>
        <dl className="z-source-facts">
          {facts.map(([term, value]) => (
            <div key={term} style={{ display: "contents" }}>
              <dt>{term}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      </section>
      <section className="z-source-section">
        <h2>Connection</h2>
        {source.settings === null ? (
          <Alert variant="warning">
            The stored connection settings are unreadable. Change the connection
            to replace them.
          </Alert>
        ) : (
          <dl className="z-source-facts">
            {Object.entries(source.settings).map(([key, value]) => (
              <div key={key} style={{ display: "contents" }}>
                <dt>{key}</dt>
                <dd>{String(value)}</dd>
              </div>
            ))}
          </dl>
        )}
      </section>
    </>
  );
};
