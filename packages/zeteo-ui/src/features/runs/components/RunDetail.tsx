import { formatCount } from "@/features/sources/components/sourceLabels";
import { Badge, Button, Modal } from "@kosmeo-ui/react";
import { formatDuration } from "@/utils/formatDuration";
import { PrincipalLabel } from "@/features/principals";
import { useEffect, useRef, useState } from "react";
import { formatDate } from "@/utils/formatDate";
import { OutcomeBadge } from "./OutcomeBadge";
import type { Run } from "../api/types";
import "./styles.css";

const ENTRY_LABEL = {
  api: "API",
  mcp: "MCP",
  export: "Export",
  dashboard: "Dashboard",
} as const;

const COPIED_MS = 2000;

interface RunDetailProps {
  run: Run;
  /** The source's slug and name when known; the raw id otherwise. */
  sourceLabel: string | null;
  onClose: () => void;
}

export const RunDetail = ({ run, sourceLabel, onClose }: RunDetailProps) => {
  const [copied, setCopied] = useState<boolean | null>(null);
  const recorded = run.query !== null && run.query !== undefined;
  const json = recorded ? (JSON.stringify(run.query, null, 2) ?? "") : "";

  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  const copy = async () => {
    let done: boolean;
    try {
      await navigator.clipboard.writeText(json);
      done = true;
    } catch {
      done = false;
    }
    setCopied(done);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(null), COPIED_MS);
  };

  return (
    <Modal
      show
      size="lg"
      title="Run"
      onClose={onClose}
      footerButtons={[
        <Button
          key="close"
          variant="secondary"
          fullWidth={false}
          onClick={onClose}
        >
          Close
        </Button>,
      ]}
    >
      <div className="z-run-detail">
        <dl>
          <dt>When</dt>
          <dd>{formatDate(run.created_at)}</dd>
          <dt>Person</dt>
          <dd>
            <PrincipalLabel refValue={{ type: "user", id: run.user_id }} />
          </dd>
          <dt>Source</dt>
          <dd>{run.source_id ? (sourceLabel ?? run.source_id) : "None"}</dd>
          {run.saved_query && (
            <>
              <dt>Saved query</dt>
              <dd>{run.saved_query.name}</dd>
            </>
          )}
          <dt>Entry point</dt>
          <dd>{ENTRY_LABEL[run.entry_point]}</dd>
          <dt>Outcome</dt>
          <dd>
            <OutcomeBadge outcome={run.outcome} />
          </dd>
          <dt>Duration</dt>
          <dd>
            {run.outcome === "running" ? "—" : formatDuration(run.duration_ms)}
          </dd>
          <dt>Rows</dt>
          <dd className="z-runs-rows">
            {run.row_count === null ? "—" : formatCount(run.row_count)}
            {run.truncated && (
              <Badge variant="warning" size="sm">
                Truncated
              </Badge>
            )}
          </dd>
          {run.error_code && (
            <>
              <dt>Error</dt>
              <dd>
                <code>{run.error_code}</code>
              </dd>
            </>
          )}
          <dt>Run id</dt>
          <dd>
            <code className="z-muted">{run.id}</code>
          </dd>
        </dl>
        <div className="z-run-query-head">
          <h3>Query</h3>
          {recorded && (
            <>
              <Button
                size="sm"
                variant="secondary"
                fullWidth={false}
                onClick={() => void copy()}
              >
                Copy
              </Button>
              {copied === true && <small role="status">Copied</small>}
              {copied === false && (
                <small role="status">Copying is not available here</small>
              )}
            </>
          )}
        </div>
        {recorded ? (
          <pre className="z-run-query" data-testid="run-query">
            {json}
          </pre>
        ) : (
          <p>No query recorded</p>
        )}
      </div>
    </Modal>
  );
};
