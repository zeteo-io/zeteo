import { FILE_SOURCES_WRITE, FileSourcesPanel } from "@/features/file-sources";
import { BorderedSection, Button, Spinner } from "@kosmeo-ui/react";
import type { SavedQuery } from "@/features/saved-queries";
import { RecentSavedQueries } from "./RecentSavedQueries";
import { isTab, TABS, tabHref, type MyTab } from "./tabs";
import { useFileSourcesEnabled } from "@/lib/useUiConfig";
import { Link, useSearchParams } from "react-router-dom";
import { ErrorNotice } from "@/components/ErrorNotice";
import { PageHeader } from "@/components/PageHeader";
import { SavedQueryCard } from "./SavedQueryCard";
import { CatalogList } from "./CatalogPanel";
import type { ApiError } from "@/lib/api";
import { useAuth } from "@tereo-io/react";
import { RunsList } from "./RunsPanel";
import type { Me } from "@/lib/auth";
import { useState } from "react";
import "./styles.css";
import {
  SaveQueryDialog,
  useMySavedQueries,
  useSharedSavedQueries,
} from "@/features/saved-queries";

interface ListState {
  items: SavedQuery[];
  isLoading: boolean;
  error: ApiError | null;
  hasMore: boolean;
  loadMore: () => void;
}

const SavedQueryList = ({
  state,
  kind,
  empty,
}: {
  state: ListState;
  kind: "mine" | "shared";
  empty: string;
}) => {
  return (
    <>
      {state.isLoading && <Spinner size="sm" />}
      <ErrorNotice error={state.error} />
      {!state.isLoading && !state.error && state.items.length === 0 && (
        <p className="z-note">{empty}</p>
      )}
      {state.items.length > 0 && (
        <div className="z-sq-grid">
          {state.items.map((sq) => (
            <SavedQueryCard key={sq.id} savedQuery={sq} kind={kind} />
          ))}
        </div>
      )}
      {state.hasMore && (
        <div className="z-my-more">
          <Button
            size="sm"
            variant="secondary"
            fullWidth={false}
            onClick={state.loadMore}
          >
            Load more
          </Button>
        </div>
      )}
    </>
  );
};

const ViewAll = ({ tab, children }: { tab: MyTab; children: string }) => (
  <Link className="z-muted-link" to={tabHref(tab)}>
    {children} →
  </Link>
);

export const MyPage = () => {
  const [params] = useSearchParams();
  const { user, hasPermission } = useAuth<Me>();
  const fileSources =
    useFileSourcesEnabled() === true && hasPermission(FILE_SOURCES_WRITE);
  const tabs = TABS.filter((t) => t.id !== "data" || fileSources);
  const raw = params.get("tab");
  const tab: MyTab =
    isTab(raw) && tabs.some((t) => t.id === raw) ? raw : "overview";
  const mine = useMySavedQueries();
  const shared = useSharedSavedQueries();
  const [creating, setCreating] = useState(false);
  const firstName = user?.name?.split(" ")[0];

  const newButton = (
    <Button size="sm" fullWidth={false} onClick={() => setCreating(true)}>
      New saved query
    </Button>
  );

  return (
    <>
      <div className="z-my-header">
        <PageHeader
          title="My Zeteo"
          subtitle={firstName ? `Welcome back, ${firstName}.` : undefined}
          actions={newButton}
          divider={false}
        />
      </div>
      <nav className="z-source-tabs" aria-label="My Zeteo">
        {tabs.map((t) => (
          <Link
            key={t.id}
            to={tabHref(t.id)}
            className={`z-source-tab${t.id === tab ? " active" : ""}`}
            aria-current={t.id === tab ? "page" : undefined}
          >
            {t.label}
          </Link>
        ))}
      </nav>

      {tab === "overview" && (
        <div className="z-my-page">
          <BorderedSection
            title="Recently used saved queries"
            as="h2"
            actions={<ViewAll tab="mine">All saved queries</ViewAll>}
          >
            <RecentSavedQueries mine={mine} shared={shared} />
          </BorderedSection>
          <BorderedSection
            title="Recent runs"
            as="h2"
            actions={<ViewAll tab="runs">All runs</ViewAll>}
          >
            <RunsList limit={10} />
          </BorderedSection>
        </div>
      )}
      {tab === "mine" && (
        <SavedQueryList
          state={mine}
          kind="mine"
          empty="Save a query from one of your recent runs, or ask your AI assistant to save one."
        />
      )}
      {tab === "shared" && (
        <SavedQueryList
          state={shared}
          kind="shared"
          empty="Nothing has been shared with you yet."
        />
      )}
      {tab === "data" && <FileSourcesPanel />}
      {tab === "runs" && (
        <div className="z-my-narrow">
          <RunsList />
        </div>
      )}
      {tab === "catalog" && (
        <div className="z-my-narrow">
          <CatalogList />
        </div>
      )}
      {creating && <SaveQueryDialog onClose={() => setCreating(false)} />}
    </>
  );
};
