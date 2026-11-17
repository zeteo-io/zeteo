import { Badge, BorderedSection, Button, Spinner } from "@kosmeo-ui/react";
import { faUser, faUserGroup } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { ConfirmButton } from "@/components/ConfirmButton";
import { formatRelative } from "@/utils/formatRelative";
import { ErrorNotice } from "@/components/ErrorNotice";
import { PageHeader } from "@/components/PageHeader";
import { Link, useNavigate } from "react-router-dom";
import { useUuidParam } from "@/lib/useUuidParam";
import { NoAccessNotice } from "./NoAccessNotice";
import { NotFound } from "@/components/NotFound";
import { formatDate } from "@/utils/formatDate";
import { useAuth } from "@tereo-io/react";
import { RunsList } from "./RunsPanel";
import type { Me } from "@/lib/auth";
import { useState } from "react";
import { tabHref } from "./tabs";
import "./styles.css";
import {
  CopyDialog,
  EditDetailsDialog,
  ShareDialog,
  TransferDialog,
  useDeleteSavedQuery,
  useSavedQuery,
  useShares,
  type SavedQuery,
} from "@/features/saved-queries";

type Dialog = "share" | "transfer" | "edit" | "copy" | null;

const When = ({ iso, never }: { iso: string | null; never: string }) =>
  iso ? (
    <time dateTime={iso} title={formatDate(iso)}>
      {formatRelative(iso)}
    </time>
  ) : (
    <span className="z-muted">{never}</span>
  );

export const SavedQueryPage = () => {
  const id = useUuidParam("savedQueryId");
  return id ? <SavedQueryView key={id} savedQueryId={id} /> : <NotFound />;
};

const SharesList = ({ savedQueryId }: { savedQueryId: string }) => {
  const shares = useShares(savedQueryId);
  if (shares.isLoading) return <Spinner size="sm" />;
  if (shares.error) return <ErrorNotice error={shares.error} />;
  const list = shares.data ?? [];
  if (list.length === 0) {
    return <p className="z-note">Not shared with anyone yet.</p>;
  }
  return (
    <ul className="z-run-list" aria-label="Shared with">
      {list.map((s) => (
        <li key={`${s.type}:${s.id}`} className="z-run-row">
          <span className="z-principal-cell">
            <FontAwesomeIcon
              className="z-principal-icon"
              icon={s.type === "group" ? faUserGroup : faUser}
              aria-hidden
            />
            {s.name ?? s.id}
            {s.email && <span className="z-principal-email">{s.email}</span>}
          </span>
        </li>
      ))}
    </ul>
  );
};

const SavedQueryView = ({ savedQueryId }: { savedQueryId: string }) => {
  const { data: sq, error, isLoading } = useSavedQuery(savedQueryId);
  const { user, hasPermission } = useAuth<Me>();
  const remove = useDeleteSavedQuery();
  const navigate = useNavigate();
  const [dialog, setDialog] = useState<Dialog>(null);
  const [copied, setCopied] = useState(false);

  if (isLoading) return <Spinner size="lg" />;
  if (!sq) {
    return (
      <>
        <ErrorNotice error={error} />
        <p>
          <Link to={tabHref("mine")}>My saved queries</Link>
        </p>
      </>
    );
  }

  const isOwner = !!user && sq.owner.id === user.id;
  const canManage = isOwner || hasPermission("zeteo.saved_queries.write");
  // The server sends a share count only to whoever may see the shares.
  const seesShares = sq.share_count !== undefined;
  const backTab = isOwner ? "mine" : sq.shared_at ? "shared" : "mine";
  const close = () => setDialog(null);

  const copyJson = async (query: SavedQuery["query"]) => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(query, null, 2));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // A browser without clipboard access: the JSON is still on the page.
    }
  };

  const actions = (
    <div className="z-header-actions">
      {isOwner && (
        <Button
          size="sm"
          variant="secondary"
          fullWidth={false}
          onClick={() => setDialog("edit")}
        >
          Edit details
        </Button>
      )}
      {!isOwner && sq.accessible && (
        <Button
          size="sm"
          variant="secondary"
          fullWidth={false}
          onClick={() => setDialog("copy")}
        >
          Copy to mine
        </Button>
      )}
      {canManage && (
        <>
          <Button
            size="sm"
            variant="secondary"
            fullWidth={false}
            onClick={() => setDialog("share")}
          >
            Share
          </Button>
          <Button
            size="sm"
            variant="secondary"
            fullWidth={false}
            onClick={() => setDialog("transfer")}
          >
            Transfer
          </Button>
          <ConfirmButton
            label="Delete"
            size="sm"
            danger
            confirmTitle="Delete saved query"
            confirmText={`Delete "${sq.name}"? It stops being shared and cannot be recovered.`}
            confirmLabel="Delete"
            onConfirm={async () => {
              await remove.mutateAsync(sq.id);
              navigate(tabHref("mine"));
            }}
          />
        </>
      )}
    </div>
  );

  return (
    <>
      <Link className="z-muted-link z-back-link" to={tabHref(backTab)}>
        ← {backTab === "mine" ? "My saved queries" : "Shared with me"}
      </Link>
      <div className="z-source-header">
        <PageHeader
          title={sq.name}
          badges={
            <span className="z-source-subtitle">
              {sq.source && <code>{sq.source.slug}</code>}
              <Badge size="sm" variant="secondary">
                {isOwner ? "Yours" : `From ${sq.owner.name ?? "someone"}`}
              </Badge>
            </span>
          }
          actions={actions}
          divider={false}
        />
      </div>
      <section className="z-table-intro">
        <p className={`z-table-description${sq.description ? "" : " z-muted"}`}>
          {sq.description || "No description."}
        </p>
        {!sq.accessible && <NoAccessNotice />}
      </section>

      <div className="z-sqp-grid">
        <div className="z-sqp-main">
          {sq.accessible && sq.query !== undefined && (
            <BorderedSection
              title="Query"
              as="h2"
              actions={
                <Button
                  size="sm"
                  variant="secondary"
                  fullWidth={false}
                  onClick={() => void copyJson(sq.query)}
                >
                  {copied ? "Copied" : "Copy JSON"}
                </Button>
              }
            >
              <pre className="z-my-json z-sqp-json" aria-label="Query JSON">
                {JSON.stringify(sq.query, null, 2)}
              </pre>
            </BorderedSection>
          )}
          <BorderedSection title="Your runs" as="h2">
            <RunsList
              savedQueryId={sq.id}
              empty="You have not run this saved query yet."
            />
          </BorderedSection>
        </div>
        <div className="z-sqp-side">
          <BorderedSection title="Details" as="h2">
            <dl className="z-source-facts">
              <dt>Owner</dt>
              <dd>{sq.owner.name ?? sq.owner.id}</dd>
              {sq.source && (
                <>
                  <dt>Source</dt>
                  <dd>
                    <code>{sq.source.slug}</code>
                  </dd>
                </>
              )}
              <dt>You last ran it</dt>
              <dd>
                <When iso={sq.you_last_ran_at} never="Never" />
              </dd>
              <dt>Last run</dt>
              <dd>
                <When iso={sq.last_run_at} never="Never" />
              </dd>
              {sq.shared_at && (
                <>
                  <dt>Shared with you</dt>
                  <dd>
                    <When iso={sq.shared_at} never="—" />
                  </dd>
                </>
              )}
              <dt>Updated</dt>
              <dd>
                <When iso={sq.updated_at} never="—" />
              </dd>
              <dt>Created</dt>
              <dd>
                <When iso={sq.created_at} never="—" />
              </dd>
            </dl>
          </BorderedSection>
          {seesShares && (
            <BorderedSection title="Shared with" as="h2">
              <SharesList savedQueryId={sq.id} />
            </BorderedSection>
          )}
        </div>
      </div>

      {dialog === "share" && (
        <ShareDialog savedQueryId={sq.id} onClose={close} />
      )}
      {dialog === "transfer" && (
        <TransferDialog savedQueryId={sq.id} onClose={close} />
      )}
      {dialog === "edit" && (
        <EditDetailsDialog savedQuery={sq} onClose={close} />
      )}
      {dialog === "copy" && <CopyDialog savedQuery={sq} onClose={close} />}
    </>
  );
};
