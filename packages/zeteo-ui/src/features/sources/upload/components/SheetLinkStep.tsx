import { BorderedSection, Button, Input, Spinner } from "@kosmeo-ui/react";
import { useGoogleConnection } from "@/features/connections";
import { ErrorNotice } from "@/components/ErrorNotice";
import { useEffect, useRef, useState } from "react";
import type { SheetStaging } from "../api/types";
import { useStageSheet } from "../api/uploads";
import { useAuth } from "@tereo-io/react";
import { Link } from "react-router-dom";
import "./styles.css";

/** Failures that belong to the link the person typed. */
const LINK_ERRORS = [
  "invalid_sheet_link",
  "sheet_in_use",
  "sheet_not_accessible",
];

const CopyButton = ({ text }: { text: string }) => {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // No clipboard (an insecure page, or refused): the address is on screen to select.
    }
  };
  return (
    <Button
      size="sm"
      variant="secondary"
      fullWidth={false}
      aria-label="Copy email address"
      onClick={() => void copy()}
    >
      {copied ? "Copied" : "Copy"}
    </Button>
  );
};

interface SheetLinkStepProps {
  /** An existing Sheets source: its own spreadsheet is read, so there is no link to type. */
  sourceId?: string;
  onStaged: (staging: SheetStaging) => void;
}

/**
 * Step one of a Google Sheet: share it with Zeteo's service account, give its
 * link, and its tabs come back as a preview (or, for Add tables to a Sheets
 * source, they are read at once).
 */
export const SheetLinkStep = ({ sourceId, onStaged }: SheetLinkStepProps) => {
  const { hasPermission } = useAuth();
  const connection = useGoogleConnection();
  const stage = useStageSheet();
  const [url, setUrl] = useState("");
  const asked = useRef(false);

  const read = (body: { url: string } | { source_id: string }) =>
    stage.mutate(body, { onSuccess: onStaged });

  useEffect(() => {
    if (!sourceId || asked.current) return;
    asked.current = true;
    stage.mutate({ source_id: sourceId }, { onSuccess: onStaged });
    // Once per page: a retry is the person's own click.
  }, [sourceId]);

  const email = connection.data?.service_account_email;
  const error = stage.error;
  const linkError =
    error && LINK_ERRORS.includes(error.code) ? error.message : undefined;

  const share = email && (
    <p className="z-fs-share">
      Share the sheet with <strong>{email}</strong> as a Viewer
      <CopyButton text={email} />
    </p>
  );

  if (sourceId) {
    return (
      <BorderedSection title="Google Sheet" as="h2">
        {share}
        {stage.isPending || (!error && !stage.isSuccess) ? (
          <div className="z-fs-reading">
            <Spinner size="md" />
            <span>Reading the sheet…</span>
          </div>
        ) : null}
        <ErrorNotice error={error} />
        {error && (
          <Button
            size="sm"
            variant="secondary"
            fullWidth={false}
            onClick={() => read({ source_id: sourceId })}
          >
            Try again
          </Button>
        )}
      </BorderedSection>
    );
  }

  if (connection.isLoading) return <Spinner size="lg" />;

  if (connection.error) {
    return <ErrorNotice error={connection.error} />;
  }

  if (!connection.data) {
    return (
      <BorderedSection title="Google Sheet" as="h2">
        <p>An admin needs to set up Google Sheets first</p>
        {hasPermission("zeteo.sources.write") && (
          <p className="z-note">
            You can do it under <Link to="/connections">Connections</Link>.
          </p>
        )}
      </BorderedSection>
    );
  }

  const trimmed = url.trim();
  return (
    <BorderedSection title="Google Sheet" as="h2">
      {share}
      <form
        className="z-fs-link"
        onSubmit={(e) => {
          e.preventDefault();
          if (trimmed && !stage.isPending) read({ url: trimmed });
        }}
      >
        <Input
          label="Link to the Google Sheet"
          placeholder="https://docs.google.com/spreadsheets/d/…"
          value={url}
          error={linkError}
          onChange={(e) => {
            setUrl(e.target.value);
            if (stage.error) stage.reset();
          }}
        />
        <Button
          type="submit"
          size="sm"
          fullWidth={false}
          isLoading={stage.isPending}
          disabled={!trimmed || stage.isPending}
        >
          Preview
        </Button>
      </form>
      <p className="z-note">
        You check the tabs, names and types it finds before anything is created.
        Zeteo keeps its own copy and syncs it on a schedule.
      </p>
      {!linkError && <ErrorNotice error={error} />}
    </BorderedSection>
  );
};
