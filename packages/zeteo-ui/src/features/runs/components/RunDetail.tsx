import { Badge, Button, Modal } from "@kosmeo-ui/react";
import { formatDuration } from "@/utils/formatDuration";
import { PrincipalLabel } from "@/features/principals";
import { formatDate } from "@/utils/formatDate";
import { OutcomeBadge } from "./OutcomeBadge";
import type { Run } from "../api/types";
import { useState } from "react";
import "./styles.css";

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

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(json);
      setCopied(true);
    } catch {
      setCopied(false);
    }
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
          <dt>Id</dt>
          <dd>
            <code>{run.id}</code>
          </dd>
          <dt>When</dt>
          <dd>{formatDate(run.created_at)}</dd>
          <dt>Person</dt>
          <dd>
            <PrincipalLabel refValue={{ type: "user", id: run.user_id }} />
          </dd>
          <dt>Source</dt>
          <dd>{run.source_id ? (sourceLabel ?? run.source_id) : "None"}</dd>
          <dt>Entry point</dt>
          <dd>{run.entry_point}</dd>
          <dt>Outcome</dt>
          <dd>
            <OutcomeBadge outcome={run.outcome} />
          </dd>
          <dt>Duration</dt>
          <dd>
            {run.outcome === "running" ? "—" : formatDuration(run.duration_ms)}
          </dd>
          <dt>Rows</dt>
          <dd>{run.row_count ?? "—"}</dd>
          <dt>Truncated</dt>
          <dd>
            {run.truncated ? (
              <Badge variant="warning" size="sm">
                Truncated
              </Badge>
            ) : (
              "No"
            )}
          </dd>
          <dt>Error code</dt>
          <dd>{run.error_code ? <code>{run.error_code}</code> : "—"}</dd>
        </dl>
        <h3>Query</h3>
        {recorded ? (
          <>
            <pre className="z-run-query" data-testid="run-query">
              {json}
            </pre>
            <Button
              size="sm"
              variant="secondary"
              fullWidth={false}
              onClick={() => void copy()}
            >
              Copy
            </Button>{" "}
            {copied === true && <small role="status">Copied</small>}
            {copied === false && (
              <small role="status">Copying is not available here</small>
            )}
          </>
        ) : (
          <p>No query recorded</p>
        )}
      </div>
    </Modal>
  );
};
