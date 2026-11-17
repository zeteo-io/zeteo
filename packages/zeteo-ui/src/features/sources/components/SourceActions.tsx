import type { RefreshSummary, Source, TestResult } from "../api/types";
import { ConfirmButton } from "@/components/ConfirmButton";
import { useArchiveSource } from "../api/useArchiveSource";
import { useRefreshSource } from "../api/useRefreshSource";
import { ErrorNotice } from "@/components/ErrorNotice";
import { useTestSource } from "../api/useTestSource";
import { Alert, Button } from "@kosmeo-ui/react";
import { useNavigate } from "react-router-dom";
import type { ApiError } from "@/lib/api";
import { useAuth } from "@tereo-io/react";
import { useState } from "react";

const Counts = ({ label, counts }: { label: string; counts: object }) => (
  <li>
    {label}:{" "}
    {Object.entries(counts)
      .map(([name, n]) => `${n} ${name}`)
      .join(", ")}
  </li>
);

/**
 * The source's actions, shown in its page header on every tab, and what the
 * last one reported, shown under the tabs.
 */
export const useSourceActions = (source: Source) => {
  const { hasPermission } = useAuth();
  const navigate = useNavigate();
  const test = useTestSource(source.id);
  const refresh = useRefreshSource(source.id);
  const archive = useArchiveSource(source.id);
  const [testResult, setTestResult] = useState<TestResult | null>(null);
  const [summary, setSummary] = useState<RefreshSummary | null>(null);
  const [error, setError] = useState<ApiError | null>(null);

  const canWrite = hasPermission("zeteo.sources.write") && !source.archived_at;
  const busy = test.isPending || refresh.isPending || archive.isPending;

  const runTest = () => {
    if (busy) return;
    setError(null);
    setTestResult(null);
    setSummary(null);
    test.mutate(undefined, { onSuccess: setTestResult, onError: setError });
  };
  const runRefresh = () => {
    if (busy) return;
    setError(null);
    setTestResult(null);
    setSummary(null);
    refresh.mutate(undefined, { onSuccess: setSummary, onError: setError });
  };

  const actions = canWrite ? (
    <div className="z-source-actions">
      <Button
        size="sm"
        variant="secondary"
        fullWidth={false}
        isLoading={test.isPending}
        disabled={busy}
        onClick={runTest}
      >
        Test connection
      </Button>
      <Button
        size="sm"
        variant="secondary"
        fullWidth={false}
        isLoading={refresh.isPending}
        disabled={busy}
        onClick={runRefresh}
      >
        Refresh catalogue
      </Button>
      <Button
        size="sm"
        fullWidth={false}
        onClick={() => navigate(`/sources/${source.id}/edit`)}
      >
        Edit
      </Button>
      <span className="z-source-actions-gap" />
      <ConfirmButton
        danger
        size="sm"
        label="Archive"
        confirmTitle="Archive this source?"
        confirmText="Archiving closes the source's connections and stops all further changes to it. Grants on its tables stop working: no one can query them any more. It cannot be undone."
        confirmLabel="Archive source"
        onConfirm={() => archive.mutateAsync()}
      />
    </div>
  ) : null;

  const results = (
    <>
      <ErrorNotice error={error} />
      {testResult && (
        <div className="z-source-result">
          <Alert variant={testResult.findings.length ? "warning" : "success"}>
            {testResult.findings.length === 0 ? (
              "Connected. The login is read-only."
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
    </>
  );

  return { actions, results };
};
